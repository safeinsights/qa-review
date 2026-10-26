import { describe, expect, it } from 'vitest'
import { extractSummary, spliceSummary } from '@/engine/release-summary'

const PLAN =
    '# Regression plan v1\n\n## Summary\n\nFirst para.\n\n**Nav.** Second para.\n\n## Baseline\n- [BASELINE] x — y\n'

describe('extractSummary', () => {
    it('returns the Summary section text only', () => {
        expect(extractSummary(PLAN)).toBe('First para.\n\n**Nav.** Second para.')
    })
    it('throws when the section is missing or empty', () => {
        expect(() => extractSummary('# x\n## Baseline\n')).toThrow(/Summary/)
        expect(() => extractSummary('## Summary\n\n## Baseline\n')).toThrow(/empty/)
    })
})

const BODY =
    '## Related Releases\n\n- [Setup App v1](u)\n\n------\n\n| PR # | Author |\n|---|---|\n| #1 | a |\n'
const BLOCK = (s: string) =>
    `<!-- regression-summary -->\n## What changed\n${s}\n<!-- /regression-summary -->`

describe('spliceSummary', () => {
    it('inserts before the ------ separator, keeping the rest byte-exact', () => {
        const out = spliceSummary(BODY, 'S1')
        expect(out).toBe(
            `## Related Releases\n\n- [Setup App v1](u)\n\n${BLOCK('S1')}\n\n------\n\n| PR # | Author |\n|---|---|\n| #1 | a |\n`
        )
    })
    it('replaces an existing block on a second save', () => {
        const once = spliceSummary(BODY, 'S1')
        const twice = spliceSummary(once, 'S2')
        expect(twice).toBe(spliceSummary(BODY, 'S2'))
        expect(twice.match(/regression-summary/g)).toHaveLength(2)
    })
    it('appends when there is no separator', () => {
        expect(spliceSummary('Just notes.\n', 'S')).toBe(`Just notes.\n\n${BLOCK('S')}\n`)
        expect(spliceSummary('', 'S')).toBe(`${BLOCK('S')}\n`)
    })
    it('does not match a longer dash line', () => {
        const b = 'a\n--------\nb\n'
        expect(spliceSummary(b, 'S')).toBe(`a\n--------\nb\n\n${BLOCK('S')}\n`)
    })
})
