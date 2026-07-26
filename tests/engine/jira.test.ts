import { describe, expect, it } from 'vitest'
import { splitBodyIntoSegments } from '@/cli/commands/jira'
import { buildCommentAdf, extractMediaId, jiraConfigFromEnv } from '@/engine/jira'

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
