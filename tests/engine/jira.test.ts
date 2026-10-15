import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { splitBodyIntoSegments } from '@/cli/commands/jira'
import {
    buildCommentAdf,
    downloadAttachment,
    extractMediaId,
    isTextAttachment,
    jiraConfig,
    jiraConfigFromEnv,
    jiraFetch,
    listAttachments,
    splitExpands,
} from '@/engine/jira'

const UUID = '0f8b4e2a-1c3d-4f5a-9b7e-2d6c8a1f3b5d'

describe('extractMediaId', () => {
    it('pulls the uuid out of an attachment-content redirect', () => {
        expect(
            extractMediaId(`https://api.media.atlassian.com/file/${UUID}/binary?token=abc`)
        ).toBe(UUID)
    })

    it('matches regardless of host, so proxied/OAuth redirect chains still resolve', () => {
        expect(
            extractMediaId(`https://api.atlassian.com/ex/jira/cloud-id/file/${UUID}/binary`)
        ).toBe(UUID)
    })

    it('returns null when the location carries no file uuid', () => {
        expect(extractMediaId('https://example.com/download/attachment/12345')).toBeNull()
        expect(extractMediaId('')).toBeNull()
    })
})

describe('buildCommentAdf', () => {
    it('renders an image as a mediaSingle node keyed by the media uuid', () => {
        const doc = buildCommentAdf([{ type: 'media', mediaId: UUID }])
        const media = (doc.content as Record<string, never>[])[0]
        expect(media.type).toBe('mediaSingle')
        expect(media.content[0]).toMatchObject({
            type: 'media',
            attrs: { id: UUID, type: 'file' },
        })
    })

    it('preserves the order of interleaved text and images', () => {
        const doc = buildCommentAdf([
            { type: 'text', text: 'before' },
            { type: 'media', mediaId: UUID },
            { type: 'text', text: 'after' },
        ])
        expect((doc.content as { type: string }[]).map(node => node.type)).toEqual([
            'paragraph',
            'mediaSingle',
            'paragraph',
        ])
    })

    it('splits blank-line-separated prose into separate paragraphs', () => {
        const doc = buildCommentAdf([{ type: 'text', text: 'one\n\ntwo' }])
        expect(doc.content).toHaveLength(2)
    })

    it('always emits at least one node, since ADF rejects an empty doc', () => {
        expect(buildCommentAdf([]).content).toHaveLength(1)
    })

    // Text segments are markdown → ADF (not literal text), so Claude's verdict
    // formatting renders instead of showing raw `##`/`**`/`-` characters.
    it('converts a markdown heading to an ADF heading node', () => {
        const doc = buildCommentAdf([{ type: 'text', text: '## Verdict: PASS' }])
        const node = (doc.content as Record<string, unknown>[])[0]
        expect(node).toMatchObject({ type: 'heading', attrs: { level: 2 } })
    })

    it('converts **bold** to a text node with a strong mark', () => {
        const doc = buildCommentAdf([{ type: 'text', text: 'the **login** flow' }])
        const para = (doc.content as { content: Record<string, unknown>[] }[])[0]
        const bold = para.content.find(n => (n as { text?: string }).text === 'login') as Record<
            string,
            unknown
        >
        expect(bold.marks).toEqual([{ type: 'strong' }])
    })

    it('converts a markdown bullet list to an ADF bulletList', () => {
        const doc = buildCommentAdf([{ type: 'text', text: '- one\n- two' }])
        const list = (doc.content as Record<string, unknown>[])[0]
        expect(list.type).toBe('bulletList')
        expect((list.content as unknown[]).length).toBe(2)
    })

    it('converts a markdown link to a text node with a link mark', () => {
        const doc = buildCommentAdf([{ type: 'text', text: '[here](https://x.co)' }])
        const para = (doc.content as { content: Record<string, unknown>[] }[])[0]
        const link = para.content[0] as { marks?: Record<string, unknown>[] }
        expect(link.marks?.[0]).toMatchObject({ type: 'link', attrs: { href: 'https://x.co' } })
    })
})

describe('splitBodyIntoSegments', () => {
    it('appends unreferenced images after the body', () => {
        const segments = splitBodyIntoSegments('verdict text', ['a', 'b'])
        expect(segments).toEqual([
            { type: 'text', text: 'verdict text' },
            { type: 'media', mediaId: 'a' },
            { type: 'media', mediaId: 'b' },
        ])
    })

    it('places an image where its placeholder sits', () => {
        const segments = splitBodyIntoSegments('intro\n\n{{image:1}}\n\noutro', ['a'])
        expect(segments.map(s => s.type)).toEqual(['text', 'media', 'text'])
    })

    it('mixes placeholders with trailing appends', () => {
        const segments = splitBodyIntoSegments('a{{image:2}}b', ['first', 'second'])
        expect(segments).toEqual([
            { type: 'text', text: 'a' },
            { type: 'media', mediaId: 'second' },
            { type: 'text', text: 'b' },
            { type: 'media', mediaId: 'first' },
        ])
    })

    it('leaves a placeholder pointing at a missing image as literal text', () => {
        const segments = splitBodyIntoSegments('text {{image:9}}', [])
        expect(segments).toEqual([{ type: 'text', text: 'text {{image:9}}' }])
    })
})

// A sandbox-blocked host and a genuine outage both surface as `TypeError: fetch failed`,
// which names neither. These assert the wrapper turns that into something actionable —
// the failure that cost a real validation session two retries.
describe('jiraFetch', () => {
    const offline = () => Promise.reject(new TypeError('fetch failed'))

    afterEach(() => {
        vi.unstubAllGlobals()
    })

    it('names the unreachable host and the sandbox allowlist fix', async () => {
        vi.stubGlobal('fetch', offline)
        await expect(
            jiraFetch('https://openstax.atlassian.net/rest/api/3/issue/OTTER-1/comment', {})
        ).rejects.toThrow(/openstax\.atlassian\.net.*sandbox\.network\.allowedDomains/s)
    })

    it('preserves the original error as the cause', async () => {
        vi.stubGlobal('fetch', offline)
        const error = await jiraFetch('https://openstax.atlassian.net/x', {}).catch(e => e)
        expect((error as Error).cause).toBeInstanceOf(TypeError)
    })

    // Success must pass straight through — the wrapper only translates rejections.
    it('returns the response untouched when the request succeeds', async () => {
        const response = new Response('ok', { status: 200 })
        vi.stubGlobal('fetch', () => Promise.resolve(response))
        await expect(jiraFetch('https://openstax.atlassian.net/x', {})).resolves.toBe(response)
    })
})

describe('jiraConfigFromEnv', () => {
    it('requires the token', () => {
        expect(() => jiraConfigFromEnv({ JIRA_USERNAME: 'a@b.c' } as NodeJS.ProcessEnv)).toThrow(
            /JIRA_API_TOKEN/
        )
    })

    // The Jira account email is NOT the git email, so there is deliberately no
    // fallback — a wrong identity would surface as a confusing 401.
    it('requires the username rather than guessing one', () => {
        expect(() => jiraConfigFromEnv({ JIRA_API_TOKEN: 't' } as NodeJS.ProcessEnv)).toThrow(
            /JIRA_USERNAME/
        )
    })

    it('trims a trailing slash so urls do not double up', () => {
        const config = jiraConfigFromEnv({
            JIRA_URL: 'https://example.atlassian.net/',
            JIRA_USERNAME: 'a@b.c',
            JIRA_API_TOKEN: 't',
        } as NodeJS.ProcessEnv)
        expect(config.baseUrl).toBe('https://example.atlassian.net')
    })
})

describe('jiraConfig (from merged settings vars)', () => {
    // The GUI stores JIRA_USERNAME/URL/token in settings.local.json; loadSettings()
    // merges them into a Vars map. jiraConfig reads that map so `qar jira-comment`
    // works WITHOUT the env var being exported into the process.
    it('resolves the config from a settings-style var map (no env needed)', () => {
        const config = jiraConfig({
            JIRA_URL: 'https://openstax.atlassian.net',
            JIRA_USERNAME: 'qa@rice.edu',
            JIRA_API_TOKEN: 'tok',
        })
        expect(config).toEqual({
            baseUrl: 'https://openstax.atlassian.net',
            email: 'qa@rice.edu',
            apiToken: 'tok',
        })
    })

    it('still fails loudly when the username is absent from settings and env', () => {
        expect(() => jiraConfig({ JIRA_API_TOKEN: 'tok' })).toThrow(/JIRA_USERNAME/)
    })
})

describe('listAttachments', () => {
    afterEach(() => {
        vi.unstubAllGlobals()
        vi.restoreAllMocks()
    })

    it('requests only the attachment field and maps the rows', async () => {
        const fetchMock = vi.fn().mockResolvedValue(
            new Response(
                JSON.stringify({
                    fields: {
                        attachment: [
                            {
                                id: '10',
                                filename: 'manualtest617.md',
                                mimeType: 'text/markdown',
                                size: 1200,
                            },
                            { id: '11', filename: 'shot.png', mimeType: 'image/png', size: 90000 },
                        ],
                    },
                }),
                { status: 200 }
            )
        )
        vi.stubGlobal('fetch', fetchMock)
        const rows = await listAttachments(
            { baseUrl: 'https://x.atlassian.net', email: 'a', apiToken: 'b' },
            'OTTER-617'
        )
        expect(fetchMock.mock.calls[0][0]).toBe(
            'https://x.atlassian.net/rest/api/3/issue/OTTER-617?fields=attachment'
        )
        expect(rows).toEqual([
            { id: '10', filename: 'manualtest617.md', mimeType: 'text/markdown', size: 1200 },
            { id: '11', filename: 'shot.png', mimeType: 'image/png', size: 90000 },
        ])
    })
})

describe('isTextAttachment', () => {
    it('accepts text mime types and md/txt/csv names, rejects images', () => {
        expect(
            isTextAttachment({
                id: '1',
                filename: 'a.md',
                mimeType: 'application/octet-stream',
                size: 1,
            })
        ).toBe(true)
        expect(
            isTextAttachment({ id: '1', filename: 'a.bin', mimeType: 'text/plain', size: 1 })
        ).toBe(true)
        expect(
            isTextAttachment({ id: '1', filename: 'a.png', mimeType: 'image/png', size: 1 })
        ).toBe(false)
    })
})

describe('downloadAttachment', () => {
    afterEach(() => {
        vi.unstubAllGlobals()
        vi.restoreAllMocks()
    })

    it('follows the content redirect and writes the bytes', async () => {
        const fetchMock = vi.fn().mockResolvedValue(new Response('# plan', { status: 200 }))
        vi.stubGlobal('fetch', fetchMock)
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qar-att-'))
        const dest = path.join(dir, 'plan.md')
        await downloadAttachment(
            { baseUrl: 'https://x.atlassian.net', email: 'a', apiToken: 'b' },
            '10',
            dest
        )
        expect(fetchMock.mock.calls[0][0]).toBe(
            'https://x.atlassian.net/rest/api/3/attachment/content/10'
        )
        expect(fetchMock.mock.calls[0][1].redirect).toBe('follow')
        expect(fs.readFileSync(dest, 'utf8')).toBe('# plan')
        fs.rmSync(dir, { recursive: true, force: true })
    })
})

describe('splitExpands', () => {
    it('splits an expand block out of surrounding markdown', () => {
        expect(splitExpands('intro\n\n{expand:Passed (2)}\n- a\n- b\n{expand}\n\nafter')).toEqual([
            { kind: 'markdown', text: 'intro\n\n' },
            { kind: 'expand', title: 'Passed (2)', text: '- a\n- b\n' },
            { kind: 'markdown', text: '\n\nafter' },
        ])
    })

    it('treats a missing closing tag as "to the end"', () => {
        expect(splitExpands('{expand:T}\nbody')).toEqual([
            { kind: 'expand', title: 'T', text: 'body' },
        ])
    })
})

describe('buildCommentAdf expand and mention', () => {
    it('emits an ADF expand node with the title and inner blocks', () => {
        const doc = buildCommentAdf([
            { type: 'text', text: '{expand:Passed (2)}\n- a\n- b\n{expand}' },
        ])
        const node = (doc.content as Record<string, unknown>[])[0]
        expect(node.type).toBe('expand')
        expect(node.attrs).toEqual({ title: 'Passed (2)' })
        expect((node.content as { type: string }[])[0].type).toBe('bulletList')
    })

    it('replaces {{mention}} with a mention node inline', () => {
        const doc = buildCommentAdf([{ type: 'text', text: 'Decisions for {{mention}}:' }], {
            mention: '62a8e164bfade2006964f268',
        })
        const para = (doc.content as Record<string, unknown>[])[0]
        const inline = para.content as Record<string, unknown>[]
        expect(inline.map(n => n.type)).toEqual(['text', 'mention', 'text'])
        expect(inline[1].attrs).toEqual({ id: '62a8e164bfade2006964f268' })
    })

    it('prepends a mention paragraph when the body has no placeholder', () => {
        const doc = buildCommentAdf([{ type: 'text', text: 'hello' }], { mention: 'abc' })
        const first = (doc.content as Record<string, unknown>[])[0]
        expect((first.content as { type: string }[])[0].type).toBe('mention')
    })
})
