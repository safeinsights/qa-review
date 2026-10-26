import { describe, expect, it } from 'vitest'
import { PlanLinesError, parsePlanLines } from '@/engine/plan-lines'

const PLAN = `# Regression plan v1.6.9

## Summary
Words for PMs.

## Baseline
- [BASELINE] Run release-happy-path — qar run --suite release-happy-path

## Changes
### #1110 OTTER-794 migrations
- [R-1110-1] Old studies show the new pill — open a study created before the release
- [R-1110-2] New studies too — create one

## Security
- [S-1] Signin query values are dropped — append ?redirect=//evil to /signin (staging only)
- [S-2] No secrets in Sentry — read the Sentry scrubbing config

## Technical appendix
Stuff.
`

describe('parsePlanLines', () => {
    it('reads every tagged line with its section, pr, and staging flag', () => {
        const inv = parsePlanLines(PLAN, 'v1.6.9')
        expect(inv.card).toBe('v1.6.9')
        expect(inv.lines.map(l => l.id)).toEqual(['BASELINE', 'R-1110-1', 'R-1110-2', 'S-1', 'S-2'])
        const r1 = inv.lines[1]
        expect(r1).toMatchObject({
            title: 'Old studies show the new pill',
            text: 'open a study created before the release',
            section: 'changes',
            pr: 1110,
            stagingOnly: false,
            kind: 'check',
        })
        expect(inv.lines[3]).toMatchObject({ section: 'security', stagingOnly: true })
        expect(inv.lines[3].text).not.toMatch(/staging only/)
    })

    it('rejects duplicate ids', () => {
        const dup = PLAN.replace('[R-1110-2]', '[R-1110-1]')
        expect(() => parsePlanLines(dup, 'v')).toThrow(/R-1110-1: duplicate/)
    })

    it('rejects a missing section, naming it', () => {
        const noSec = PLAN.replace(/## Security[\s\S]*?(?=## Technical)/, '')
        expect(() => parsePlanLines(noSec, 'v')).toThrow(/missing section "Security"/)
    })

    it('rejects sections out of order', () => {
        const swapped = PLAN.replace('## Baseline', '## TMP')
            .replace('## Changes', '## Baseline')
            .replace('## TMP', '## Changes')
        expect(() => parsePlanLines(swapped, 'v')).toThrow(/order/)
    })

    it('rejects an R- line outside Changes and an S- line outside Security', () => {
        const wrong = PLAN.replace('- [S-2]', '- [R-9-1]')
        expect(() => parsePlanLines(wrong, 'v')).toThrow(/R-9-1: an R- line belongs in Changes/)
    })

    it('rejects a line with no title or no steps', () => {
        const bare = PLAN.replace(
            '- [S-2] No secrets in Sentry — read the Sentry scrubbing config',
            '- [S-2] No secrets'
        )
        expect(() => parsePlanLines(bare, 'v')).toThrow(/S-2: needs "<title> — <steps>"/)
    })

    it('collects every problem into the error', () => {
        const bad = PLAN.replace('[R-1110-2]', '[R-1110-1]').replace(
            '- [S-2] No secrets in Sentry — read the Sentry scrubbing config',
            '- [S-2] x'
        )
        try {
            parsePlanLines(bad, 'v')
            throw new Error('did not throw')
        } catch (e) {
            expect(e).toBeInstanceOf(PlanLinesError)
            expect((e as PlanLinesError).problems).toHaveLength(2)
        }
    })
})
