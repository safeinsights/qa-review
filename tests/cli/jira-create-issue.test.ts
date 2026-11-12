import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { jiraCreateIssueCommand } from '@/cli/commands/jira-create-issue'

const vars = { JIRA_USERNAME: 'a@b.c', JIRA_API_TOKEN: 't', JIRA_URL: 'https://x.atlassian.net' }
const UUID = '0f8b4e2a-1c3d-4f5a-9b7e-2d6c8a1f3b5d'
const TEAM_FIELD = 'customfield_10001'
const PARENT_TEAM = 'de0cdb64-61d5-4134-b2c1-b54e212cc6e0'

type TeamScreen = 'required' | 'optional' | 'absent'

function stubJira(
    overrides: {
        issueTypes?: string[]
        linkTypes?: string[]
        missing?: string
        team?: TeamScreen
        parentTeam?: string | null
    } = {}
) {
    const calls: Array<{ url: string; method: string; body?: unknown }> = []
    const team = overrides.team ?? 'absent'
    const parentTeam = overrides.parentTeam === undefined ? PARENT_TEAM : overrides.parentTeam
    vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string, init: RequestInit = {}) => {
            calls.push({
                url,
                method: init.method ?? 'GET',
                body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
            })
            if (url.includes('/createmeta/') && url.includes('/issuetypes/')) {
                const fields = [{ fieldId: 'summary', name: 'Summary', required: true }]
                if (team !== 'absent') {
                    fields.push({
                        fieldId: TEAM_FIELD,
                        name: 'Team',
                        required: team === 'required',
                    })
                }
                return new Response(JSON.stringify({ fields, total: fields.length }), {
                    status: 200,
                })
            }
            if (url.includes('/createmeta/')) {
                return new Response(
                    JSON.stringify({
                        issueTypes: (overrides.issueTypes ?? ['Task', 'Bug']).map((name, i) => ({
                            id: String(10200 + i),
                            name,
                        })),
                    }),
                    { status: 200 }
                )
            }
            if (overrides.missing && url.includes(`/issue/${overrides.missing}?`)) {
                return new Response('{}', { status: 404 })
            }
            if (/\/issue\/[A-Z]+-\d+\?fields=/.test(url)) {
                const fields: Record<string, unknown> = { summary: 'parent' }
                if (parentTeam) fields[TEAM_FIELD] = { id: parentTeam, name: 'SI Otter' }
                return new Response(JSON.stringify({ fields }), { status: 200 })
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
            'GET /rest/api/3/issue/createmeta/OTTER/issuetypes/10201?startAt=0&maxResults=100',
            'GET /rest/api/3/issueLinkType',
            'GET /rest/api/3/issue/OTTER-617?fields=summary',
            'POST /rest/api/3/issue',
            'POST /rest/api/3/issue/OTTER-901/attachments',
            'GET /rest/api/3/attachment/content/55',
            'PUT /rest/api/3/issue/OTTER-901',
            'POST /rest/api/3/issueLink',
        ])
        expect(calls[8].body).toEqual({
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

    describe('Team', () => {
        const createdFields = (calls: ReturnType<typeof stubJira>) => {
            const create = calls.find(
                c => c.method === 'POST' && c.url.endsWith('/rest/api/3/issue')
            )
            if (!create) throw new Error('no POST /issue was made')
            return (create.body as { fields: Record<string, unknown> }).fields
        }

        it("files the card under the --link parent's Team when the project requires one", async () => {
            const calls = stubJira({ team: 'required' })
            const { dir, body } = tmpBody()
            vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
            await jiraCreateIssueCommand(
                { project: 'OTTER', summary: 's', 'body-file': body, link: 'OTTER-848' },
                vars
            )
            expect(calls.some(c => c.url.endsWith(`/OTTER-848?fields=summary,${TEAM_FIELD}`))).toBe(
                true
            )
            expect(createdFields(calls)[TEAM_FIELD]).toBe(PARENT_TEAM)
            fs.rmSync(dir, { recursive: true, force: true })
        })

        it("prefers --team over the parent's Team", async () => {
            const calls = stubJira({ team: 'required' })
            const { dir, body } = tmpBody()
            vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
            await jiraCreateIssueCommand(
                {
                    project: 'OTTER',
                    summary: 's',
                    'body-file': body,
                    link: 'OTTER-848',
                    team: 'other-team',
                },
                vars
            )
            expect(createdFields(calls)[TEAM_FIELD]).toBe('other-team')
            fs.rmSync(dir, { recursive: true, force: true })
        })

        it('refuses before creating anything when Team is required and nothing supplies one', async () => {
            const noLink = stubJira({ team: 'required' })
            const { dir, body } = tmpBody()
            await expect(
                jiraCreateIssueCommand({ project: 'OTTER', summary: 's', 'body-file': body }, vars)
            ).rejects.toThrow(/OTTER requires a Team\. Pass --team/)
            expect(noLink.some(c => c.method === 'POST')).toBe(false)

            const teamless = stubJira({ team: 'required', parentTeam: null })
            await expect(
                jiraCreateIssueCommand(
                    { project: 'OTTER', summary: 's', 'body-file': body, link: 'OTTER-848' },
                    vars
                )
            ).rejects.toThrow(/OTTER-848 has no Team/)
            expect(teamless.some(c => c.method === 'POST')).toBe(false)
            fs.rmSync(dir, { recursive: true, force: true })
        })

        it('sends no Team to a project whose screen has none, and rejects an explicit one there', async () => {
            const calls = stubJira({ team: 'absent' })
            const { dir, body } = tmpBody()
            vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
            await jiraCreateIssueCommand(
                { project: 'SHRMP', summary: 's', 'body-file': body, link: 'SHRMP-1' },
                vars
            )
            expect(createdFields(calls)).not.toHaveProperty(TEAM_FIELD)

            const explicit = stubJira({ team: 'absent' })
            await expect(
                jiraCreateIssueCommand(
                    { project: 'SHRMP', summary: 's', 'body-file': body, team: PARENT_TEAM },
                    vars
                )
            ).rejects.toThrow(/SHRMP Bug has no Team field/)
            expect(explicit.some(c => c.method === 'POST')).toBe(false)
            fs.rmSync(dir, { recursive: true, force: true })
        })

        it('rejects a bare --team', async () => {
            const calls = stubJira({ team: 'required' })
            const { dir, body } = tmpBody()
            await expect(
                jiraCreateIssueCommand(
                    { project: 'OTTER', summary: 's', 'body-file': body, team: 'true' },
                    vars
                )
            ).rejects.toThrow(/--team needs a team id/)
            expect(calls).toEqual([])
            fs.rmSync(dir, { recursive: true, force: true })
        })
    })

    it('names the created key when a later step fails', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn(async (url: string, init: RequestInit = {}) => {
                if (url.includes('/createmeta/')) {
                    return new Response(
                        JSON.stringify({ issueTypes: [{ id: '10209', name: 'Bug' }] }),
                        {
                            status: 200,
                        }
                    )
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
                    return new Response(
                        JSON.stringify({ issueTypes: [{ id: '10209', name: 'Bug' }] }),
                        {
                            status: 200,
                        }
                    )
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
