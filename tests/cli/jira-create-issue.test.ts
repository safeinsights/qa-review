import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { jiraCreateIssueCommand } from '@/cli/commands/jira-create-issue'

const vars = { JIRA_USERNAME: 'a@b.c', JIRA_API_TOKEN: 't', JIRA_URL: 'https://x.atlassian.net' }
const UUID = '0f8b4e2a-1c3d-4f5a-9b7e-2d6c8a1f3b5d'

function stubJira(
    overrides: { issueTypes?: string[]; linkTypes?: string[]; missing?: string } = {}
) {
    const calls: Array<{ url: string; method: string; body?: unknown }> = []
    vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string, init: RequestInit = {}) => {
            calls.push({
                url,
                method: init.method ?? 'GET',
                body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
            })
            if (url.includes('/createmeta/')) {
                return new Response(
                    JSON.stringify({
                        issueTypes: (overrides.issueTypes ?? ['Task', 'Bug']).map(name => ({
                            name,
                        })),
                    }),
                    { status: 200 }
                )
            }
            if (overrides.missing && url.includes(`/issue/${overrides.missing}?`)) {
                return new Response('{}', { status: 404 })
            }
            if (url.endsWith('/issueLinkType')) {
                return new Response(
                    JSON.stringify({
                        issueLinkTypes: (overrides.linkTypes ?? ['Relates']).map(name => ({
                            name,
                        })),
                    }),
                    { status: 200 }
                )
            }
            if (url.endsWith('/rest/api/3/issue') && init.method === 'POST') {
                return new Response(JSON.stringify({ id: '1', key: 'OTTER-901' }), { status: 201 })
            }
            if (url.includes('/attachments')) {
                return new Response(JSON.stringify([{ id: '55' }]), { status: 200 })
            }
            if (url.includes('/attachment/content/')) {
                return new Response('', {
                    status: 303,
                    headers: { location: `https://m/file/${UUID}/binary` },
                })
            }
            return new Response(null, { status: 204 })
        })
    )
    return calls
}

// Uploads are confined to <repo>/.tmp, so the fixture builds a throwaway repo root.
function tmpBody(): { dir: string; body: string; image: string } {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'qar-ci-'))
    vi.stubEnv('QAR_REPO_DIR', repo)
    const dir = path.join(repo, '.tmp')
    fs.mkdirSync(dir)
    const body = path.join(dir, 'card.md')
    const image = path.join(dir, 'shot.png')
    fs.writeFileSync(body, '## Expected\nx\n\n{{image:1}}')
    fs.writeFileSync(image, Buffer.from([0x89, 0x50]))
    return { dir, body, image }
}

describe('jira-create-issue', () => {
    afterEach(() => {
        vi.unstubAllGlobals()
        vi.unstubAllEnvs()
        vi.restoreAllMocks()
    })

    it('refuses an image outside the scratch dir before creating anything', async () => {
        const calls = stubJira()
        const { body } = tmpBody()
        const outside = path.join(os.tmpdir(), `qar-outside-${process.pid}.png`)
        fs.writeFileSync(outside, 'x')
        await expect(
            jiraCreateIssueCommand(
                { project: 'OTTER', summary: 's', 'body-file': body, images: outside },
                vars
            )
        ).rejects.toThrow(/Refusing to upload/)
        expect(calls).toEqual([])
        fs.rmSync(outside)
    })

    it('rejects a bare --link, and a nonexistent parent, before creating the card', async () => {
        const calls = stubJira()
        const { body } = tmpBody()
        const base = { project: 'OTTER', summary: 's', 'body-file': body }
        await expect(jiraCreateIssueCommand({ ...base, link: 'true' }, vars)).rejects.toThrow(
            /--link needs an issue key/
        )
        expect(calls).toEqual([])

        const missing = stubJira({ missing: 'OTTER-6177' })
        await expect(jiraCreateIssueCommand({ ...base, link: 'OTTER-6177' }, vars)).rejects.toThrow(
            /OTTER-6177 does not exist/
        )
        expect(missing.some(c => c.method === 'POST' && c.url.endsWith('/rest/api/3/issue'))).toBe(
            false
        )
    })

    it('verifies types, creates, uploads, describes, links, and prints the key', async () => {
        const calls = stubJira()
        const { dir, body, image } = tmpBody()
        const out: string[] = []
        vi.spyOn(process.stdout, 'write').mockImplementation(s => {
            out.push(String(s))
            return true
        })
        await jiraCreateIssueCommand(
            {
                project: 'OTTER',
                summary: 'Pending state missing',
                'body-file': body,
                images: image,
                link: 'OTTER-617',
            },
            vars
        )
        expect(JSON.parse(out.at(-1) as string)).toEqual({
            key: 'OTTER-901',
            url: 'https://x.atlassian.net/browse/OTTER-901',
        })
        const methods = calls.map(
            c => `${c.method} ${c.url.replace('https://x.atlassian.net', '')}`
        )
        expect(methods).toEqual([
            'GET /rest/api/3/issue/createmeta/OTTER/issuetypes',
            'GET /rest/api/3/issueLinkType',
            'GET /rest/api/3/issue/OTTER-617?fields=summary',
            'POST /rest/api/3/issue',
            'POST /rest/api/3/issue/OTTER-901/attachments',
            'GET /rest/api/3/attachment/content/55',
            'PUT /rest/api/3/issue/OTTER-901',
            'POST /rest/api/3/issueLink',
        ])
        expect(calls[7].body).toEqual({
            type: { name: 'Relates' },
            inwardIssue: { key: 'OTTER-901' },
            outwardIssue: { key: 'OTTER-617' },
        })
        fs.rmSync(dir, { recursive: true, force: true })
    })

    it('stops before POST /issue when the issue type is unknown, listing the valid names', async () => {
        const calls = stubJira({ issueTypes: ['Task', 'Story'] })
        const { dir, body } = tmpBody()
        await expect(
            jiraCreateIssueCommand({ project: 'OTTER', summary: 's', 'body-file': body }, vars)
        ).rejects.toThrow(/Bug.*Task, Story/)
        expect(calls.some(c => c.method === 'POST')).toBe(false)
        fs.rmSync(dir, { recursive: true, force: true })
    })

    it('stops when the link type is unknown', async () => {
        const calls = stubJira({ linkTypes: ['Blocks'] })
        const { dir, body } = tmpBody()
        await expect(
            jiraCreateIssueCommand(
                { project: 'OTTER', summary: 's', 'body-file': body, link: 'OTTER-617' },
                vars
            )
        ).rejects.toThrow(/Relates.*Blocks/)
        expect(calls.some(c => c.method === 'POST')).toBe(false)
        fs.rmSync(dir, { recursive: true, force: true })
    })

    it('names the created key when a later step fails', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn(async (url: string, init: RequestInit = {}) => {
                if (url.includes('/createmeta/')) {
                    return new Response(JSON.stringify({ issueTypes: [{ name: 'Bug' }] }), {
                        status: 200,
                    })
                }
                if (url.endsWith('/rest/api/3/issue') && init.method === 'POST') {
                    return new Response(JSON.stringify({ id: '1', key: 'OTTER-902' }), {
                        status: 201,
                    })
                }
                return new Response('boom', { status: 500 })
            })
        )
        const { dir, body } = tmpBody()
        await expect(
            jiraCreateIssueCommand({ project: 'OTTER', summary: 's', 'body-file': body }, vars)
        ).rejects.toThrow(/Created OTTER-902, but setting the description failed/)
        fs.rmSync(dir, { recursive: true, force: true })
    })

    it('names the created key and the link step when linking fails', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn(async (url: string, init: RequestInit = {}) => {
                if (url.includes('/createmeta/')) {
                    return new Response(JSON.stringify({ issueTypes: [{ name: 'Bug' }] }), {
                        status: 200,
                    })
                }
                if (url.endsWith('/issueLinkType')) {
                    return new Response(JSON.stringify({ issueLinkTypes: [{ name: 'Relates' }] }), {
                        status: 200,
                    })
                }
                if (url.endsWith('/rest/api/3/issue') && init.method === 'POST') {
                    return new Response(JSON.stringify({ id: '1', key: 'OTTER-901' }), {
                        status: 201,
                    })
                }
                if (url.endsWith('/issueLink')) return new Response('boom', { status: 500 })
                return new Response(null, { status: 204 })
            })
        )
        const { dir, body } = tmpBody()
        await expect(
            jiraCreateIssueCommand(
                { project: 'OTTER', summary: 's', 'body-file': body, link: 'OTTER-617' },
                vars
            )
        ).rejects.toThrow(/Created OTTER-901, but linking to OTTER-617 failed/)
        fs.rmSync(dir, { recursive: true, force: true })
    })

    it('requires --project, --summary and --body-file', async () => {
        await expect(jiraCreateIssueCommand({}, vars)).rejects.toThrow('--project')
    })
})
