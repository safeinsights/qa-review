import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
    assertUnderReleaseDir,
    collectReleasePrs,
    localPlanDiffers,
    previousTag,
    prNumbersFromBody,
    prNumbersFromSubjects,
    releaseStatus,
    uploadAsset,
} from '@/engine/github-release'
import { releaseDir } from '@/engine/release-paths'

const BOARDS = ['OTTER', 'SHRIMP', 'SHRMP', 'SIINFOSEC']

describe('prNumbersFromSubjects', () => {
    it('reads merge commits and squash commits, once each, in order', () => {
        expect(
            prNumbersFromSubjects([
                'Merge pull request #1110 from safeinsights/otter-794',
                'OTTER-801: update Mailgun templates (#1111)',
                'Merge pull request #1110 from safeinsights/otter-794',
                'Fix x (see #99) (#1112)',
                'Bump deps',
            ])
        ).toEqual([1110, 1111, 1112])
    })

    it('ignores a (#n) that is not at the end of the subject', () => {
        expect(prNumbersFromSubjects(['Revert "(#55)" because of a bug'])).toEqual([])
    })
})

describe('prNumbersFromBody', () => {
    it('reads the PR number from the first cell even when a cell holds a pipe', () => {
        const body = [
            '| PR # | Author | Title | Merged Date | Ticket # |',
            '|------|--------|-------|-------------|----------|',
            '| #1112 | a | <details>x | y</details> | 2026-10-05 |  |',
            '| #1110 | b | plain | 2026-10-05 | [OTTER-794](u) |',
        ].join('\n')
        expect(prNumbersFromBody(body)).toEqual([1112, 1110])
    })

    it('returns [] for a body with no table', () => {
        expect(prNumbersFromBody('## Related Releases\n- x')).toEqual([])
    })
})

describe('previousTag', () => {
    it('is the tag after the given one in a newest-first list', () => {
        expect(previousTag(['v1.6.9', 'v1.6.8', 'v1.6.7'], 'v1.6.8')).toBe('v1.6.7')
    })
    it('throws for the oldest tag and for an unknown tag', () => {
        expect(() => previousTag(['v1.6.9', 'v1.6.8'], 'v1.6.8')).toThrow(/no previous release/)
        expect(() => previousTag(['v1.6.9'], 'v9.9.9')).toThrow(/not a release/)
    })
})

// A fake gh that answers the four calls collectReleasePrs makes.
function fakeGh(calls: string[][]) {
    return async (args: string[]): Promise<string> => {
        calls.push(args)
        const joined = args.join(' ')
        if (joined.startsWith('api repos/r/releases?')) {
            return JSON.stringify([
                { tag_name: 'v2', body: '| PR # |\n|---|\n| #10 |\n| #99 |' },
                { tag_name: 'v1', body: '' },
            ])
        }
        if (joined.includes('/compare/v1...v2')) {
            return ['Merge pull request #10 from x', 'Otter 802 squash (#11)'].join('\n')
        }
        if (joined.startsWith('pr view 10')) {
            return JSON.stringify({
                number: 10,
                title: 'SIINFOSEC-1626: drop invalid signin',
                author: { login: 'a' },
                mergedAt: '2026-10-01T00:00:00Z',
                headRefName: 'siinfosec-1626',
                body: 'Fixes SIINFOSEC-1626',
                files: [{ path: 'src/a.ts' }],
                additions: 3,
                deletions: 1,
            })
        }
        if (joined.startsWith('pr view 11')) {
            return JSON.stringify({
                number: 11,
                title: 'Otter 802 squash',
                author: { login: 'b' },
                mergedAt: '2026-10-02T00:00:00Z',
                headRefName: 'otter-802',
                body: 'also OTTER-471',
                files: [],
                additions: 0,
                deletions: 0,
            })
        }
        throw new Error(`unexpected gh ${joined}`)
    }
}

describe('collectReleasePrs', () => {
    it('derives the set from the compare and reports the body diff', async () => {
        const calls: string[][] = []
        const result = await collectReleasePrs(fakeGh(calls), 'r', 'v2', BOARDS)
        expect(result.previousTag).toBe('v1')
        expect(result.prs.map(p => p.number)).toEqual([10, 11])
        expect(result.prs[0].jiraKeys).toEqual(['SIINFOSEC-1626'])
        expect(result.prs[1].jiraKeys).toEqual(['OTTER-802', 'OTTER-471'])
        expect(result.prs[0].files).toEqual(['src/a.ts'])
        expect(result.notesMissing).toEqual([11])
        expect(result.notesExtra).toEqual([99])
        // Every gh call names the repo explicitly.
        for (const c of calls) expect(c.join(' ')).toMatch(/repos\/r|--repo r/)
    })
})

describe('releaseStatus', () => {
    let repo: string
    let prior: string | undefined
    beforeEach(() => {
        prior = process.env.QAR_REPO_DIR
        repo = fs.mkdtempSync(path.join(os.tmpdir(), 'qar-release-'))
        process.env.QAR_REPO_DIR = repo
    })
    afterEach(() => {
        if (prior === undefined) delete process.env.QAR_REPO_DIR
        else process.env.QAR_REPO_DIR = prior
        fs.rmSync(repo, { recursive: true, force: true })
    })

    const gh = async (args: string[]): Promise<string> => {
        const joined = args.join(' ')
        if (joined.startsWith('api repos/r/releases/tags/v2')) {
            return JSON.stringify({
                assets: [
                    {
                        name: 'testing-plan.md',
                        browser_download_url: 'https://x/plan',
                        size: 12,
                        updated_at: '2026-10-20T00:00:00Z',
                    },
                ],
            })
        }
        if (joined.startsWith('api repos/r --jq .permissions.push')) return 'true'
        if (joined.startsWith('release download v2')) {
            const dir = args[args.indexOf('--dir') + 1]
            fs.writeFileSync(path.join(dir, 'testing-plan.md'), 'remote plan')
            return ''
        }
        throw new Error(`unexpected gh ${joined}`)
    }

    it('reports assets, upload rights, and whether the local plan differs', async () => {
        const dir = releaseDir('v2')
        fs.mkdirSync(dir, { recursive: true })
        fs.writeFileSync(path.join(dir, 'plan.md'), 'local plan')
        fs.writeFileSync(path.join(dir, 'results-staging.json'), '{}')
        const status = await releaseStatus(gh, 'r', 'v2', dir)
        expect(status.exists).toBe(true)
        expect(status.canUpload).toBe(true)
        expect(status.assets.map(a => a.name)).toEqual(['testing-plan.md'])
        expect(status.local).toEqual({
            plan: true,
            planDiffers: true,
            results: ['results-staging.json'],
        })
    })

    it('reports a missing release without throwing', async () => {
        const gone = async (args: string[]): Promise<string> => {
            if (args.join(' ').includes('releases/tags/')) throw new Error('HTTP 404')
            return 'true'
        }
        const status = await releaseStatus(gone, 'r', 'v9', releaseDir('v9'))
        expect(status.exists).toBe(false)
        expect(status.assets).toEqual([])
    })
})

describe('localPlanDiffers', () => {
    it('ignores the local Security section, which the asset never has', () => {
        const local = '## Changes\nA\n\n## Security\n- [S-1] t — p\n\n## Technical appendix\nB\n'
        const remote = '## Changes\nA\n\n## Technical appendix\nB\n'
        expect(localPlanDiffers(local, remote)).toBe(false)
        expect(localPlanDiffers(local.replace('A', 'edited'), remote)).toBe(true)
    })
})

describe('assertUnderReleaseDir', () => {
    it('accepts a file in the release dir and rejects one outside it', () => {
        const inside = path.join(releaseDir('v2'), 'plan.md')
        expect(() => assertUnderReleaseDir('v2', inside)).not.toThrow()
        expect(() => assertUnderReleaseDir('v2', path.join(releaseDir('v2'), '..', 'x'))).toThrow(
            /under/
        )
        expect(() => assertUnderReleaseDir('v2', '/etc/passwd')).toThrow(/under/)
    })
})

describe('release error handling and upload guards', () => {
    let repo: string
    let prior: string | undefined
    beforeEach(() => {
        prior = process.env.QAR_REPO_DIR
        repo = fs.mkdtempSync(path.join(os.tmpdir(), 'qar-release-g-'))
        process.env.QAR_REPO_DIR = repo
    })
    afterEach(() => {
        if (prior === undefined) delete process.env.QAR_REPO_DIR
        else process.env.QAR_REPO_DIR = prior
        fs.rmSync(repo, { recursive: true, force: true })
    })

    it('rejects on a non-404 failure but maps a 404 to exists:false', async () => {
        const boom = async () => {
            throw new Error('HTTP 500')
        }
        await expect(releaseStatus(boom, 'r', 'v2', releaseDir('v2'))).rejects.toThrow(/500/)
        const gone = async (args: string[]) => {
            if (args.join(' ').includes('releases/tags/')) throw new Error('HTTP 404')
            return 'true'
        }
        expect((await releaseStatus(gone, 'r', 'v2', releaseDir('v2'))).exists).toBe(false)
    })

    it('clobbers only the plan asset', async () => {
        const calls: string[][] = []
        const gh = async (args: string[]) => {
            calls.push(args)
            if (args[0] === 'api')
                return JSON.stringify({
                    assets: ['testing-plan.md', 'regression-results-staging-x.md'].map(name => ({
                        name,
                        browser_download_url: `https://x/${name}`,
                        size: 1,
                        updated_at: '',
                    })),
                })
            return ''
        }
        const file = path.join(releaseDir('v2'), 'plan.md')
        fs.mkdirSync(releaseDir('v2'), { recursive: true })
        fs.writeFileSync(file, 'x')
        await uploadAsset(gh, 'r', 'v2', file, 'testing-plan.md')
        await uploadAsset(gh, 'r', 'v2', file, 'regression-results-staging-x.md')
        const uploads = calls.filter(c => c[0] === 'release')
        expect(uploads[0]).toContain('--clobber')
        expect(uploads[1]).not.toContain('--clobber')
    })

    it('refuses to upload a file that holds security lines', async () => {
        const calls: string[][] = []
        const gh = async (args: string[]) => {
            calls.push(args)
            return ''
        }
        fs.mkdirSync(releaseDir('v2'), { recursive: true })
        const file = path.join(releaseDir('v2'), 'plan.md')
        fs.writeFileSync(file, '## Summary\nx\n\n## Security\n- [S-1] t — p\n')
        await expect(uploadAsset(gh, 'r', 'v2', file, 'testing-plan.md')).rejects.toThrow(
            'refusing to upload testing-plan.md: it contains security lines; management-app is public'
        )
        expect(calls).toEqual([])
    })

    it('rejects a symlink in the release dir that points outside it', () => {
        fs.mkdirSync(releaseDir('v2'), { recursive: true })
        const secret = path.join(repo, 'secret.txt')
        fs.writeFileSync(secret, 's')
        const link = path.join(releaseDir('v2'), 'link.md')
        fs.symlinkSync(secret, link)
        expect(() => assertUnderReleaseDir('v2', link)).toThrow(/under/)
    })

    it('rejects . and .. and slashes as tags', () => {
        for (const t of ['.', '..', 'a/b']) expect(() => releaseDir(t)).toThrow(/not a release tag/)
    })
})
