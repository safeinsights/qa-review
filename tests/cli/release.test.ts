import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let repo: string
let prior: string | undefined
beforeEach(() => {
    prior = process.env.QAR_REPO_DIR
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'qar-release-cli-'))
    process.env.QAR_REPO_DIR = repo
})
afterEach(() => {
    if (prior === undefined) delete process.env.QAR_REPO_DIR
    else process.env.QAR_REPO_DIR = prior
    fs.rmSync(repo, { recursive: true, force: true })
    vi.restoreAllMocks()
})

const vars = { JIRA_BOARDS: 'OTTER', MANAGEMENT_APP_REPO: 'r' }

describe('release commands', () => {
    it('release-prs writes prs.json into the release dir and prints a summary', async () => {
        const { releasePrsCommand } = await import('@/cli/commands/release')
        const { releaseDir } = await import('@/engine/release-paths')
        const gh = async (args: string[]) => {
            const j = args.join(' ')
            if (j.startsWith('api repos/r/releases?'))
                return JSON.stringify([
                    { tag_name: 'v2', body: '' },
                    { tag_name: 'v1', body: '' },
                ])
            if (j.includes('/compare/')) return 'Merge pull request #1 from x'
            return JSON.stringify({
                number: 1,
                title: 'OTTER-1 t',
                author: { login: 'a' },
                mergedAt: '',
                headRefName: '',
                body: '',
                files: [],
                additions: 0,
                deletions: 0,
            })
        }
        const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
        await releasePrsCommand({ tag: 'v2' }, vars, gh)
        const written = JSON.parse(fs.readFileSync(path.join(releaseDir('v2'), 'prs.json'), 'utf8'))
        expect(written.prs[0].jiraKeys).toEqual(['OTTER-1'])
        expect(written.notesMissing).toEqual([1])
        const printed = JSON.parse(String(write.mock.calls[0][0]))
        expect(printed).toMatchObject({ tag: 'v2', previousTag: 'v1', prs: 1, notesMissing: 1 })
    })

    it('release-prs requires --tag', async () => {
        const { releasePrsCommand } = await import('@/cli/commands/release')
        await expect(releasePrsCommand({}, vars, async () => '')).rejects.toThrow(/--tag/)
    })

    it('release-upload refuses a file outside the release dir', async () => {
        const { releaseUploadCommand } = await import('@/cli/commands/release')
        const outside = path.join(repo, 'x.md')
        fs.writeFileSync(outside, 'x')
        await expect(
            releaseUploadCommand({ tag: 'v2', file: outside }, vars, async () => '')
        ).rejects.toThrow(/under/)
    })
})
