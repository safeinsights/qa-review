import { afterEach, describe, expect, it, vi } from 'vitest'
import { jiraDeleteAttachmentCommand } from '@/cli/commands/jira'

const vars = { JIRA_USERNAME: 'a@b.c', JIRA_API_TOKEN: 't', JIRA_URL: 'https://x.atlassian.net' }

function stubJira(rows: unknown[], deleteStatus = 204) {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) =>
        init?.method === 'DELETE'
            ? new Response(null, { status: deleteStatus })
            : new Response(JSON.stringify({ fields: { attachment: rows } }), { status: 200 })
    )
    vi.stubGlobal('fetch', fetchMock)
    return fetchMock
}

function captureStdout(): string[] {
    const out: string[] = []
    vi.spyOn(process.stdout, 'write').mockImplementation(s => {
        out.push(String(s))
        return true
    })
    return out
}

function deletedUrls(fetchMock: ReturnType<typeof stubJira>): string[] {
    return fetchMock.mock.calls.filter(([, init]) => init?.method === 'DELETE').map(([url]) => url)
}

describe('jira-delete-attachment', () => {
    afterEach(() => {
        vi.unstubAllGlobals()
        vi.restoreAllMocks()
    })

    it('deletes the attachments on the card', async () => {
        const fetchMock = stubJira([
            { id: '10', filename: 'shot.png', mimeType: 'image/png', size: 5 },
            { id: '11', filename: 'results.json', mimeType: 'application/json', size: 5 },
        ])
        const out = captureStdout()
        await jiraDeleteAttachmentCommand({ issue: 'OTTER-1', ids: '10,11' }, vars)
        expect(deletedUrls(fetchMock)).toEqual([
            'https://x.atlassian.net/rest/api/3/attachment/10',
            'https://x.atlassian.net/rest/api/3/attachment/11',
        ])
        expect(out.map(l => JSON.parse(l))).toEqual([
            { id: '10', filename: 'shot.png', deleted: true },
            { id: '11', filename: 'results.json', deleted: true },
        ])
    })

    it('never deletes an id that is not on the card', async () => {
        const fetchMock = stubJira([
            { id: '10', filename: 'shot.png', mimeType: 'image/png', size: 5 },
        ])
        const out = captureStdout()
        await jiraDeleteAttachmentCommand({ issue: 'OTTER-1', ids: '99,10' }, vars)
        expect(deletedUrls(fetchMock)).toEqual(['https://x.atlassian.net/rest/api/3/attachment/10'])
        const first = JSON.parse(out[0])
        expect(first).toMatchObject({ id: '99', deleted: false })
        expect(first.note).toMatch(/not attached to OTTER-1/)
    })

    it('treats a 404 on delete as already gone', async () => {
        stubJira([{ id: '10', filename: 'shot.png', mimeType: 'image/png', size: 5 }], 404)
        const out = captureStdout()
        await jiraDeleteAttachmentCommand({ issue: 'OTTER-1', ids: '10' }, vars)
        expect(JSON.parse(out[0])).toEqual({ id: '10', filename: 'shot.png', deleted: true })
    })

    it('fails on a refused delete', async () => {
        stubJira([{ id: '10', filename: 'shot.png', mimeType: 'image/png', size: 5 }], 403)
        captureStdout()
        await expect(
            jiraDeleteAttachmentCommand({ issue: 'OTTER-1', ids: '10' }, vars)
        ).rejects.toThrow('Deleting attachment 10 failed (403)')
    })

    it('requires --issue and --ids', async () => {
        await expect(jiraDeleteAttachmentCommand({ ids: '10' }, vars)).rejects.toThrow('--issue')
        await expect(jiraDeleteAttachmentCommand({ issue: 'OTTER-1' }, vars)).rejects.toThrow(
            '--ids'
        )
    })
})
