import { describe, expect, it } from 'vitest'
import { splitBodyIntoSegments } from '@/cli/commands/jira'
import {
    buildCommentAdf,
    extractMediaId,
    jiraConfig,
    jiraConfigFromEnv,
    jiraFetch,
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

    it('names the unreachable host and the sandbox allowlist fix', async () => {
        const original = globalThis.fetch
        globalThis.fetch = offline as unknown as typeof fetch
        try {
            await expect(
                jiraFetch('https://openstax.atlassian.net/rest/api/3/issue/OTTER-1/comment', {})
            ).rejects.toThrow(/openstax\.atlassian\.net.*sandbox\.network\.allowedDomains/s)
        } finally {
            globalThis.fetch = original
        }
    })

    it('preserves the original error as the cause', async () => {
        const original = globalThis.fetch
        globalThis.fetch = offline as unknown as typeof fetch
        try {
            const error = await jiraFetch('https://openstax.atlassian.net/x', {}).catch(e => e)
            expect((error as Error).cause).toBeInstanceOf(TypeError)
        } finally {
            globalThis.fetch = original
        }
    })

    // Success must pass straight through — the wrapper only translates rejections.
    it('returns the response untouched when the request succeeds', async () => {
        const original = globalThis.fetch
        const response = new Response('ok', { status: 200 })
        globalThis.fetch = (() => Promise.resolve(response)) as unknown as typeof fetch
        try {
            await expect(jiraFetch('https://openstax.atlassian.net/x', {})).resolves.toBe(response)
        } finally {
            globalThis.fetch = original
        }
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
