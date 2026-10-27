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
            releaseUploadCommand(
                { tag: 'v2', file: outside, as: 'testing-plan.md' },
                vars,
                async () => ''
            )
        ).rejects.toThrow(/under/)
    })

    it('release-upload sends the plan without its Security section', async () => {
        const { releaseUploadCommand } = await import('@/cli/commands/release')
        const { releaseDir } = await import('@/engine/release-paths')
        const dir = releaseDir('v2')
        fs.mkdirSync(dir, { recursive: true })
        const plan = path.join(dir, 'plan.md')
        fs.writeFileSync(
            plan,
            '## Changes\nA\n\n## Security\n- [S-1] t — p\n\n## Technical appendix\nB\n'
        )
        let uploaded = ''
        const gh = async (args: string[]) => {
            if (args[0] === 'release') {
                uploaded = fs.readFileSync(args[3], 'utf8')
                return ''
            }
            return JSON.stringify({
                assets: [
                    {
                        name: 'testing-plan.md',
                        browser_download_url: 'https://x/p',
                        size: 1,
                        updated_at: '',
                    },
                ],
            })
        }
        const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
        await releaseUploadCommand({ tag: 'v2', file: plan, as: 'testing-plan.md' }, vars, gh)
        expect(uploaded).toBe('## Changes\nA\n\n## Technical appendix\nB\n')
        expect(fs.readFileSync(path.join(dir, 'public', 'testing-plan.md'), 'utf8')).toBe(uploaded)
        expect(fs.readFileSync(plan, 'utf8')).toContain('[S-1]')
        expect(JSON.parse(String(write.mock.calls[0][0]))).toEqual({
            tag: 'v2',
            asset: 'testing-plan.md',
            url: 'https://x/p',
            stripped: true,
        })
    })

    it.each([
        'security-results-staging.md',
        'plan.txt',
        '../testing-plan.md',
        'regression-results-staging-1.md',
    ])('release-upload rejects --as %s', async name => {
        const { releaseUploadCommand } = await import('@/cli/commands/release')
        const { releaseDir } = await import('@/engine/release-paths')
        fs.mkdirSync(releaseDir('v2'), { recursive: true })
        const file = path.join(releaseDir('v2'), 'x.md')
        fs.writeFileSync(file, 'x')
        await expect(
            releaseUploadCommand({ tag: 'v2', file, as: name }, vars, async () => '')
        ).rejects.toThrow(/not a release asset name/)
    })

    describe('release-upload sources', () => {
        const results = 'regression-results-staging-20261026-1200.md'
        const setup = async () => {
            const { releaseDir } = await import('@/engine/release-paths')
            const dir = releaseDir('v2')
            fs.mkdirSync(dir, { recursive: true })
            fs.writeFileSync(path.join(dir, 'plan-lines.json'), '{"lines":[]}')
            fs.writeFileSync(path.join(dir, 'results-staging.json'), '{"results":[]}')
            fs.writeFileSync(path.join(dir, 'pr-1.json'), '{"number":1}')
            fs.writeFileSync(path.join(dir, 'plan.md'), '## Changes\nA\n')
            fs.writeFileSync(path.join(dir, results), '| R-1-1 | t | PASS | ok |\n')
            return dir
        }
        const gh = (calls: string[][]) => async (args: string[]) => {
            calls.push(args)
            if (args[0] === 'release') return ''
            return JSON.stringify({
                assets: ['testing-plan.md', results].map(name => ({
                    name,
                    browser_download_url: `https://x/${name}`,
                    size: 1,
                    updated_at: '',
                })),
            })
        }

        it.each(['plan-lines.json', 'results-staging.json', 'pr-1.json'])(
            'refuses %s under any asset name',
            async name => {
                const { releaseUploadCommand } = await import('@/cli/commands/release')
                const dir = await setup()
                const calls: string[][] = []
                const file = path.join(dir, name)
                for (const as of [undefined, 'testing-plan.md', results]) {
                    const opts: Record<string, string> = as
                        ? { tag: 'v2', file, as }
                        : { tag: 'v2', file }
                    await expect(releaseUploadCommand(opts, vars, gh(calls))).rejects.toThrow(
                        /not a release asset name|refusing to upload/
                    )
                }
                expect(calls).toEqual([])
            }
        )

        it('refuses plan.md as a results asset', async () => {
            const { releaseUploadCommand } = await import('@/cli/commands/release')
            const dir = await setup()
            const calls: string[][] = []
            await expect(
                releaseUploadCommand(
                    { tag: 'v2', file: path.join(dir, 'plan.md'), as: results },
                    vars,
                    gh(calls)
                )
            ).rejects.toThrow(/refusing to upload/)
            expect(calls).toEqual([])
        })

        it('uploads the plan from plan.md and a results file from its own name', async () => {
            const { releaseUploadCommand } = await import('@/cli/commands/release')
            const dir = await setup()
            const calls: string[][] = []
            vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
            await releaseUploadCommand(
                { tag: 'v2', file: path.join(dir, 'plan.md') },
                vars,
                gh(calls)
            )
            await releaseUploadCommand(
                { tag: 'v2', file: path.join(dir, results) },
                vars,
                gh(calls)
            )
            const uploads = calls.filter(c => c[0] === 'release').map(c => path.basename(c[3]))
            expect(uploads).toEqual(['testing-plan.md', results])
        })
    })

    describe('release-download of the plan', () => {
        const remote = '## Changes\nA\n\n## Technical appendix\nB\n'
        const gh = async (args: string[]) => {
            const dir = args[args.indexOf('--dir') + 1]
            fs.writeFileSync(path.join(dir, 'testing-plan.md'), remote)
            return ''
        }
        const local = async (text: string) => {
            const { releaseDir } = await import('@/engine/release-paths')
            fs.mkdirSync(releaseDir('v2'), { recursive: true })
            const file = path.join(releaseDir('v2'), 'plan.md')
            fs.writeFileSync(file, text)
            return file
        }

        it('refuses to replace a plan.md with unsaved edits, and --force replaces it', async () => {
            const { releaseDownloadCommand } = await import('@/cli/commands/release')
            const file = await local('my edits')
            vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
            await expect(releaseDownloadCommand({ tag: 'v2' }, vars, gh)).rejects.toThrow(
                /refusing to overwrite .*--force/
            )
            expect(fs.readFileSync(file, 'utf8')).toBe('my edits')
            await releaseDownloadCommand({ tag: 'v2', force: 'true' }, vars, gh)
            expect(fs.readFileSync(file, 'utf8')).toBe(remote)
        })

        it('--force drops Changes edits but keeps the local Security section in place', async () => {
            const { releaseDownloadCommand } = await import('@/cli/commands/release')
            const assetPlan = '## Changes\n- 1.1 asset line — s\n\n## Technical appendix\nB\n'
            const ghPlan = async (args: string[]) => {
                const dir = args[args.indexOf('--dir') + 1]
                fs.writeFileSync(path.join(dir, 'testing-plan.md'), assetPlan)
                return ''
            }
            const file = await local(
                '## Changes\n- 1.1 my edit — s\n\n## Security\n- [S-1] t — p\n\n## Technical appendix\nB\n'
            )
            const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
            await releaseDownloadCommand({ tag: 'v2', force: 'true' }, vars, ghPlan)
            expect(fs.readFileSync(file, 'utf8')).toBe(
                '## Changes\n- 1.1 asset line — s\n\n## Security\n- [S-1] t — p\n\n## Technical appendix\nB\n'
            )
            expect(JSON.parse(String(write.mock.calls[0][0])).plan).toBe(
                'replaced (local Security section kept)'
            )
        })

        it('keeps a plan.md that differs only by its Security section', async () => {
            const { releaseDownloadCommand } = await import('@/cli/commands/release')
            const withSecurity = remote.replace(
                '## Technical',
                '## Security\n- [S-1] t — p\n\n## Technical'
            )
            const file = await local(withSecurity)
            vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
            await releaseDownloadCommand({ tag: 'v2' }, vars, gh)
            expect(fs.readFileSync(file, 'utf8')).toBe(withSecurity)
        })

        it('--remote-only leaves plan.md alone', async () => {
            const { releaseDownloadCommand } = await import('@/cli/commands/release')
            const file = await local('my edits')
            const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
            await releaseDownloadCommand({ tag: 'v2', 'remote-only': 'true' }, vars, gh)
            expect(fs.readFileSync(file, 'utf8')).toBe('my edits')
            const out = JSON.parse(String(write.mock.calls[0][0])).output as string
            expect(out.endsWith(path.join('remote', 'testing-plan.md'))).toBe(true)
        })
    })

    it('release-download rejects a path-like or valueless --asset', async () => {
        const { releaseDownloadCommand } = await import('@/cli/commands/release')
        await expect(
            releaseDownloadCommand({ tag: 'v2', asset: '../../x' }, vars, async () => '')
        ).rejects.toThrow(/not an asset name/)
        await expect(
            releaseDownloadCommand({ tag: 'v2', asset: 'true' }, vars, async () => '')
        ).rejects.toThrow(/requires a value for --asset/)
    })
})
