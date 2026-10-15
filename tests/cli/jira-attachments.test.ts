import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { jiraAttachmentsCommand } from '@/cli/commands/jira'

const vars = { JIRA_USERNAME: 'a@b.c', JIRA_API_TOKEN: 't', JIRA_URL: 'https://x.atlassian.net' }

function stubJira(rows: unknown[], content = 'body') {
    vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string) =>
            url.includes('/attachment/content/')
                ? new Response(content, { status: 200 })
                : new Response(JSON.stringify({ fields: { attachment: rows } }), { status: 200 })
        )
    )
}

describe('jira-attachments', () => {
    afterEach(() => {
        vi.unstubAllGlobals()
        vi.restoreAllMocks()
    })

    it('lists every attachment without downloading', async () => {
        stubJira([{ id: '10', filename: 'a.md', mimeType: 'text/markdown', size: 5 }])
        const out: string[] = []
        vi.spyOn(process.stdout, 'write').mockImplementation(s => {
            out.push(String(s))
            return true
        })
        await jiraAttachmentsCommand({ issue: 'OTTER-1' }, vars)
        expect(JSON.parse(out[0])).toEqual({
            id: '10',
            filename: 'a.md',
            mimeType: 'text/markdown',
            size: 5,
        })
    })

    it('downloads only text attachments under the size cap into --dir', async () => {
        stubJira([
            { id: '10', filename: 'plan.md', mimeType: 'text/markdown', size: 5 },
            { id: '11', filename: 'shot.png', mimeType: 'image/png', size: 5 },
            { id: '12', filename: 'huge.txt', mimeType: 'text/plain', size: 3 * 1024 * 1024 },
        ])
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qar-att-'))
        const out: string[] = []
        vi.spyOn(process.stdout, 'write').mockImplementation(s => {
            out.push(String(s))
            return true
        })
        await jiraAttachmentsCommand({ issue: 'OTTER-1', download: 'true', dir }, vars)
        const rows = out.map(l => JSON.parse(l))
        expect(rows[0].saved).toBe(path.join(dir, 'plan.md'))
        expect(fs.readFileSync(rows[0].saved, 'utf8')).toBe('body')
        expect(rows[1].saved).toBeUndefined()
        expect(rows[2].saved).toBeUndefined()
        expect(rows[2].skipped).toMatch(/2 MB/)
        fs.rmSync(dir, { recursive: true, force: true })
    })

    it('requires --issue', async () => {
        await expect(jiraAttachmentsCommand({}, vars)).rejects.toThrow('--issue')
    })
})
