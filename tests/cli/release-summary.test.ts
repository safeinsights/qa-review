import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let repo: string
let prior: string | undefined
beforeEach(() => {
    prior = process.env.QAR_REPO_DIR
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'qar-release-summary-'))
    process.env.QAR_REPO_DIR = repo
})
afterEach(() => {
    if (prior === undefined) delete process.env.QAR_REPO_DIR
    else process.env.QAR_REPO_DIR = prior
    fs.rmSync(repo, { recursive: true, force: true })
    vi.restoreAllMocks()
})

const vars = { JIRA_BOARDS: 'OTTER', MANAGEMENT_APP_REPO: 'r' }
const BODY = '## Related Releases\n\n------\n\n| PR # |\n'

describe('release-summary command', () => {
    it('inserts the plan summary above the separator and edits the release', async () => {
        const { releaseSummaryCommand } = await import('@/cli/commands/release-summary')
        const { releaseDir } = await import('@/engine/release-paths')
        const dir = releaseDir('v1')
        fs.mkdirSync(dir, { recursive: true })
        fs.writeFileSync(path.join(dir, 'plan.md'), '## Summary\n\nWhat changed.\n\n## Baseline\n')
        const edits: string[][] = []
        const gh = async (args: string[]) => {
            if (args[0] === 'api') return `${BODY}\n`
            edits.push(args)
            const notes = fs.readFileSync(args[args.indexOf('--notes-file') + 1], 'utf8')
            expect(notes.indexOf('What changed.')).toBeLessThan(notes.indexOf('------'))
            return ''
        }
        const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
        await releaseSummaryCommand({ tag: 'v1' }, vars, gh)
        expect(edits).toHaveLength(1)
        expect(edits[0]).toContain('--notes-file')
        expect(String(write.mock.calls[0][0])).toContain('"placement":"inserted"')
    })

    it('refuses a Summary with security content before touching the release', async () => {
        const { releaseSummaryCommand } = await import('@/cli/commands/release-summary')
        const { releaseDir } = await import('@/engine/release-paths')
        const dir = releaseDir('v1')
        fs.mkdirSync(dir, { recursive: true })
        fs.writeFileSync(path.join(dir, 'plan.md'), '## Summary\n\nSee S-1.\n\n## Baseline\n')
        const calls: string[][] = []
        const gh = async (args: string[]) => {
            calls.push(args)
            return ''
        }
        await expect(releaseSummaryCommand({ tag: 'v1' }, vars, gh)).rejects.toThrow(
            /security content/
        )
        expect(calls).toEqual([])
    })

    it('refuses an --input outside the release dir', async () => {
        const { releaseSummaryCommand } = await import('@/cli/commands/release-summary')
        const outside = path.join(repo, 'plan.md')
        fs.writeFileSync(outside, '## Summary\n\nWhat changed.\n')
        const calls: string[][] = []
        const gh = async (args: string[]) => {
            calls.push(args)
            return ''
        }
        await expect(
            releaseSummaryCommand({ tag: 'v1', input: outside }, vars, gh)
        ).rejects.toThrow(/under/)
        expect(calls).toEqual([])
    })

    it('requires --tag', async () => {
        const { releaseSummaryCommand } = await import('@/cli/commands/release-summary')
        await expect(releaseSummaryCommand({}, vars, async () => '')).rejects.toThrow(/--tag/)
    })
})
