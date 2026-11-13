import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

let repo: string
let prior: string | undefined
beforeEach(() => {
    prior = process.env.QAR_REPO_DIR
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'qar-release-create-'))
    process.env.QAR_REPO_DIR = repo
})
afterEach(() => {
    if (prior === undefined) delete process.env.QAR_REPO_DIR
    else process.env.QAR_REPO_DIR = prior
    fs.rmSync(repo, { recursive: true, force: true })
})

const SHA = 'a'.repeat(40)
const RELATED = 'o/lib=Lib,o/none=None'
const PLAN = `# Regression plan v1.7.0

## Summary
v1.7.0 holds 1 PR.

### Study workflow (high impact)
- Studies show a pill. [#5](https://github.com/o/app/pull/5)

## Baseline
- [BASELINE] Run release-happy-path — the QA Runner runs it when a run starts

## Changes
### 1. Researcher · no study
- 1.1 Pill shows — open a study ([PR #5](https://github.com/o/app/pull/5))

## Security
- [S-1] Secret probe — try a bad redirect (staging only)

## Technical appendix
Stuff.
`
const notFound = () => new Error('gh: Not Found (HTTP 404)')

interface Fake {
    releaseExists?: boolean
    tagSha?: string
    newest?: string
    failWith?: Error
    uploadFails?: boolean
}

// A gh that answers the calls release-create makes, and records every one.
function fakeGh(f: Fake = {}) {
    const calls: string[][] = []
    let published = false
    const gh = async (args: string[]) => {
        calls.push(args)
        if (f.failWith) throw f.failWith
        const endpoint = args.find(a => a.startsWith('repos/')) ?? ''
        if (args.includes('POST')) {
            published = true
            return 'https://github.com/o/app/releases/tag/v1.7.0\n'
        }
        if (endpoint === 'repos/o/app/releases/tags/v1.7.0') {
            if (!published && !f.releaseExists) throw notFound()
            return JSON.stringify({
                assets: [
                    { name: 'testing-plan.md', browser_download_url: 'u', size: 1, updated_at: '' },
                ],
            })
        }
        if (endpoint.startsWith('repos/o/app/releases?')) {
            return JSON.stringify([{ tag_name: f.newest ?? 'v1.6.9+a', body: '', draft: false }])
        }
        if (endpoint === 'repos/o/app/git/ref/tags/v1.7.0') {
            if (f.tagSha) return 'x'
            throw notFound()
        }
        if (endpoint === 'repos/o/app/commits/v1.7.0') return `${f.tagSha}\n`
        if (endpoint === 'repos/o/lib/releases/latest') return 'v1.2.5\n'
        if (endpoint === 'repos/o/none/releases/latest') throw notFound()
        if (args[0] === 'release' && args[1] === 'upload') {
            if (f.uploadFails) throw new Error('HTTP 502')
            return ''
        }
        throw new Error(`unexpected gh call: ${args.join(' ')}`)
    }
    return { gh, calls }
}

async function writePlan(plan = PLAN) {
    const { releaseDir } = await import('@/engine/release-paths')
    const dir = releaseDir('v1.7.0')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'plan.md'), plan)
    fs.writeFileSync(
        path.join(dir, 'prs.json'),
        JSON.stringify({ tag: 'v1.7.0', previousTag: 'v1.6.9+a', head: SHA, prs: [{ number: 5 }] })
    )
    return dir
}

async function run(f: Fake = {}, dryRun = false, tag = 'v1.7.0') {
    const { createRelease } = await import('@/engine/release-create')
    const fake = fakeGh(f)
    const out = await createRelease(fake.gh, 'o/app', tag, RELATED, dryRun)
    return { ...fake, out }
}

function posted(calls: string[][]) {
    const post = calls.find(c => c.includes('POST'))
    if (!post) return null
    return JSON.parse(fs.readFileSync(post[post.indexOf('--input') + 1], 'utf8'))
}

describe('createRelease', () => {
    it('publishes the changelog on the planned commit and attaches the plan', async () => {
        const dir = await writePlan()
        const { calls, out } = await run()
        const req = posted(calls)
        expect(req).toMatchObject({
            tag_name: 'v1.7.0',
            name: 'v1.7.0',
            draft: false,
            target_commitish: SHA,
        })
        expect(req.body).toContain('- [Lib v1.2.5](https://github.com/o/lib/releases/tag/v1.2.5)')
        expect(req.body).not.toContain('None')
        expect(req.body).toContain(
            '<!-- regression-summary -->\n## What changed\nv1.7.0 holds 1 PR.'
        )
        expect(req.body).not.toContain('| PR #')
        const upload = calls.find(c => c[0] === 'release' && c[1] === 'upload')
        expect(upload?.[2]).toBe('v1.7.0')
        const uploaded = fs.readFileSync(path.join(dir, 'public', 'testing-plan.md'), 'utf8')
        expect(uploaded).not.toContain('S-1')
        expect(out).toMatchObject({ previousTag: 'v1.6.9+a', target: SHA, planUrl: 'u' })
    })

    it('uses a pushed tag on the planned commit and sends no target', async () => {
        await writePlan()
        const { calls } = await run({ tagSha: SHA })
        expect(posted(calls).target_commitish).toBeUndefined()
    })

    it('refuses a pushed tag on another commit', async () => {
        await writePlan()
        await expect(run({ tagSha: 'b'.repeat(40) })).rejects.toThrow(/plan was written for/)
    })

    it('refuses when a newer release appeared since the plan', async () => {
        await writePlan()
        await expect(run({ newest: 'v1.6.10' })).rejects.toThrow(/regenerate the plan/)
    })

    it('refuses a plan that fails the plan-lines gate, before publishing', async () => {
        await writePlan(PLAN.replace(/- 1\.1 .*\n/, ''))
        const { createRelease } = await import('@/engine/release-create')
        const { gh, calls } = fakeGh()
        await expect(createRelease(gh, 'o/app', 'v1.7.0', RELATED, false)).rejects.toThrow(
            /PR #5 has no test line/
        )
        expect(posted(calls)).toBeNull()
    })

    it('refuses a Summary with security content', async () => {
        await writePlan(PLAN.replace('v1.7.0 holds 1 PR.', 'See S-1.'))
        await expect(run()).rejects.toThrow(/security content/)
    })

    it('needs the plan first', async () => {
        await expect(run()).rejects.toThrow(/release-create skill/)
    })

    it('writes the body and publishes nothing on a dry run', async () => {
        await writePlan()
        const { calls, out } = await run({}, true)
        expect(posted(calls)).toBeNull()
        expect(fs.readFileSync(out.bodyFile, 'utf8')).toContain('## Related Releases')
    })

    it('names the retry when the plan upload fails after publishing', async () => {
        await writePlan()
        await expect(run({ uploadFails: true })).rejects.toThrow(
            /is published at .*qar release-upload/
        )
    })

    it('refuses a tag that already has a release', async () => {
        await writePlan()
        await expect(run({ releaseExists: true })).rejects.toThrow(/already has a release/)
    })

    it('refuses a malformed tag before calling GitHub', async () => {
        const { createRelease } = await import('@/engine/release-create')
        const { gh, calls } = fakeGh()
        await expect(createRelease(gh, 'o/app', 'v1.7', RELATED, false)).rejects.toThrow(
            /not a release tag/
        )
        expect(calls).toEqual([])
    })

    it('surfaces a GitHub failure that is not a 404', async () => {
        await writePlan()
        await expect(run({ failWith: new Error('HTTP 401: Bad credentials') })).rejects.toThrow(
            /401/
        )
    })
})

describe('refuseInAppSession', () => {
    it('refuses under the marker the GUI exports, and allows a plain terminal', async () => {
        const { refuseInAppSession } = await import('@/engine/release-create')
        expect(() => refuseInAppSession({ QAR_APP_SESSION: '1' })).toThrow(/maintainer step/)
        expect(() => refuseInAppSession({})).not.toThrow()
    })
})

describe('nextPatch', () => {
    it('drops hotfix metadata and bumps the patch', async () => {
        const { nextPatch } = await import('@/engine/release-create')
        expect(nextPatch('v1.6.9+a')).toBe('v1.6.10')
    })
})
