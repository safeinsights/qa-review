import { describe, expect, it } from 'vitest'
import { type Inventory, renderInventoryHtml, summarize } from '@/engine/inventory'

const inventory: Inventory = {
    card: 'OTTER-617',
    target: 'qa',
    lines: [
        {
            id: 'RL.SubmittedBy.3',
            title: 'Most recent submitter',
            kind: 'check',
            text: 'Show the <most recent> submitter',
            source: { type: 'card', ref: 'description' },
            conflictWith: 'RL.SubmittedBy.3-figma',
        },
        {
            id: 'RL.SubmittedBy.3-figma',
            kind: 'check',
            text: 'Reset to Not submitted at the code stage',
            source: {
                type: 'figma',
                ref: 'Org dashboards / RL/Dashboard/populated',
                url: 'https://figma.com/design/abc?node-id=1-2',
                page: 'Org dashboards',
                frame: 'RL/Dashboard/populated',
                category: 'Development',
            },
            conflictWith: 'RL.SubmittedBy.3',
        },
        {
            id: 'MyStudies.NewStudy',
            kind: 'absence',
            text: 'New study button on the Researcher tab',
            source: { type: 'figma', ref: 'My studies', category: 'NOT READY FOR DEV' },
        },
        {
            id: 'Ctx.1',
            kind: 'context',
            text: 'Load page when user selects a RL name',
            source: { type: 'figma', ref: 'Org dashboards', category: 'Transition - IN' },
        },
        {
            id: 'Comment.1',
            kind: 'check',
            text: 'Last updated sorts both ways',
            source: { type: 'comment', ref: 'Iris 10/12' },
        },
    ],
}

describe('summarize', () => {
    it('counts lines by kind, conflicts once per pair, and sources by type', () => {
        expect(summarize(inventory)).toEqual({
            lines: 5,
            checks: 3,
            absences: 1,
            context: 1,
            conflicts: 1,
            sources: { card: 1, comment: 1, attachment: 0, figma: 3, observed: 0 },
        })
    })
})

describe('renderInventoryHtml hostile input', () => {
    const hostile: Inventory = {
        card: 'X-1',
        target: 'qa',
        lines: [
            {
                id: 'H.1',
                title: 't',
                kind: '"><img src=x onerror=alert(1)>' as never,
                text: 't',
                source: {
                    type: '"><script>1</script>' as never,
                    ref: 'r',
                    url: 'javascript:alert(1)',
                },
            },
        ],
    }

    it('escapes enum fields and does not link non-http URLs', () => {
        const html = renderInventoryHtml(hostile)
        expect(html).not.toContain('<img src=x')
        expect(html).not.toContain('<script>1')
        expect(html).not.toContain('javascript:')
    })
})

describe('renderInventoryHtml', () => {
    const html = renderInventoryHtml(inventory)

    it('is one self-contained page with no external resources', () => {
        expect(html.startsWith('<!doctype html>')).toBe(true)
        expect(html).not.toMatch(/<(script|link)[^>]+(src|href)=["']https?:/)
    })

    it('shows the card and the summary counts', () => {
        expect(html).toContain('OTTER-617')
        expect(html).toMatch(/5 requirements/)
        expect(html).toMatch(/1 conflict/)
        expect(html).toMatch(/1 absence/)
    })

    it('escapes requirement text', () => {
        expect(html).toContain('Show the &lt;most recent&gt; submitter')
        expect(html).not.toContain('<most recent>')
    })

    it('shows the title beside the id', () => {
        expect(html).toContain('Most recent submitter')
    })

    it('renders one row per line with its id, kind, source and category', () => {
        expect(html.match(/<tr[^>]*data-line=/g)).toHaveLength(5)
        expect(html).toContain('data-kind="absence"')
        expect(html).toContain('NOT READY FOR DEV')
        expect(html).toContain('Iris 10/12')
    })

    it('links a Figma source to its node', () => {
        expect(html).toContain('href="https://figma.com/design/abc?node-id=1-2"')
    })

    it('marks both halves of a conflict pair', () => {
        expect(html.match(/data-conflict="true"/g)).toHaveLength(2)
    })
})
