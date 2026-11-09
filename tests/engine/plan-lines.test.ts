import { describe, expect, it } from 'vitest'
import { PlanLinesError, parsePlanLines } from '@/engine/plan-lines'

const PLAN = `# Regression plan v1.6.9

## Summary
Words for PMs.

## Baseline
- [BASELINE] Run release-happy-path — qar run --suite release-happy-path

## Changes
### 1. Reviewer · no study
- 1.1 Old studies show the new pill — open a study created before the release ([PR #1110](https://github.com/o/r/pull/1110))

> Next: as researcher, start a new study proposal.

### 2. Researcher · study with a draft proposal
- 2.1 New studies too — open the draft (staging only) ([PR #1110](https://github.com/o/r/pull/1110))

## Security
- [S-1] Signin query values are dropped — append ?redirect=//evil to /signin (staging only)
- [S-2] No secrets in Sentry — read the Sentry scrubbing config

## Technical appendix
Stuff.
`

describe('the completeness gate', () => {
    it('passes when every PR has a line and every line has a PR', () => {
        expect(() => parsePlanLines(PLAN, 'v', { prs: [1110] })).not.toThrow()
    })

    it('names a PR in the release with no test line', () => {
        expect(() => parsePlanLines(PLAN, 'v', { prs: [1110, 1111] })).toThrow(
            /PR #1111 has no test line/
        )
    })

    it('names a Changes line whose PR is not in the release', () => {
        try {
            parsePlanLines(PLAN, 'v', { prs: [] })
            throw new Error('did not throw')
        } catch (e) {
            expect((e as PlanLinesError).problems).toEqual([
                '1.1 Old studies show the new pill: PR #1110 is not in the release',
                '2.1 New studies too: PR #1110 is not in the release',
            ])
        }
    })

    it('is off without a PR list', () => {
        expect(() => parsePlanLines(PLAN, 'v')).not.toThrow()
    })
})

describe('parsePlanLines', () => {
    it('reads every line with its section, pr, run setup, and staging flag', () => {
        const inv = parsePlanLines(PLAN, 'v1.6.9')
        expect(inv.card).toBe('v1.6.9')
        expect(inv.lines.map(l => l.id)).toEqual(['BASELINE', '1.1', '2.1', 'S-1', 'S-2'])
        expect(inv.lines[1]).toMatchObject({
            title: 'Old studies show the new pill',
            text: 'open a study created before the release',
            section: 'changes',
            pr: 1110,
            prUrl: 'https://github.com/o/r/pull/1110',
            role: 'reviewer',
            needs: 'none',
            stagingOnly: false,
            endsStudy: false,
            kind: 'check',
        })
        expect(inv.lines[2]).toMatchObject({
            role: 'researcher',
            needs: 'proposal-draft',
            stagingOnly: true,
            text: 'open the draft',
        })
        expect(inv.lines[3]).toMatchObject({ section: 'security', stagingOnly: true })
        expect(inv.lines[3].text).not.toMatch(/staging only/)
    })

    it('accepts a plain (PR #n) and markers in any order', () => {
        const plain = PLAN.replace(
            '(staging only) ([PR #1110](https://github.com/o/r/pull/1110))',
            '(PR #1110) (ends the study) (staging only)'
        )
        const line = parsePlanLines(plain, 'v').lines.find(l => l.id === '2.1')
        expect(line).toMatchObject({
            pr: 1110,
            stagingOnly: true,
            endsStudy: true,
            text: 'open the draft',
        })
    })

    it('rejects duplicate ids', () => {
        const dup = PLAN.replace('- 2.1 New', '- 2.1 x — y ([PR #1110](u))\n- 2.1 New')
        expect(() => parsePlanLines(dup, 'v')).toThrow(/2.1: duplicate/)
    })

    it.each([
        [
            'a line with no number',
            '- 2.1 New',
            '- New',
            /New studies too: has no number — run qar plan-order/,
        ],
        ['a number from another group', '- 2.1 New', '- 1.2 New', /1.2: is under group 2/],
        [
            'a line with no PR',
            ' (staging only) ([PR #1110](https://github.com/o/r/pull/1110))',
            '',
            /2.1: needs "\(\[PR #<n>\]/,
        ],
        [
            'an unknown role',
            '2. Researcher',
            '2. Researchr',
            /the role is one of Admin, Researcher, Reviewer/,
        ],
        [
            'an unknown stage',
            'a draft proposal',
            'a drafty proposal',
            /the setup is one of: no study; study with a draft proposal/,
        ],
        [
            'an old PR heading',
            '### 1. Reviewer · no study',
            '### #1110 OTTER-794',
            /a run group heading is/,
        ],
        ['an old [R-] line', '- 1.1 Old', '- [R-1110-1] Old', /a test line is "- <n>.<n>/],
    ])('rejects %s', (_name, from, to, problem) => {
        expect(() => parsePlanLines(PLAN.replace(from, to), 'v')).toThrow(problem)
    })

    it('rejects "(ends the study)" on a check with no study', () => {
        const bad = PLAN.replace('release ([PR', 'release (ends the study) ([PR')
        expect(() => parsePlanLines(bad, 'v')).toThrow(/needs a group with a study/)
    })

    it('rejects a missing section, naming it', () => {
        const noChanges = PLAN.replace(/## Changes[\s\S]*?(?=## Security)/, '')
        expect(() => parsePlanLines(noChanges, 'v')).toThrow(/missing section "Changes"/)
    })

    it('accepts a plan with no Security section (the public asset)', () => {
        const pub = PLAN.replace(/## Security[\s\S]*?(?=## Technical)/, '')
        expect(parsePlanLines(pub, 'v').lines.map(l => l.id)).toEqual(['BASELINE', '1.1', '2.1'])
    })

    it('rejects sections out of order', () => {
        const swapped = PLAN.replace('## Baseline', '## TMP')
            .replace('## Changes', '## Baseline')
            .replace('## TMP', '## Changes')
        expect(() => parsePlanLines(swapped, 'v')).toThrow(/order/)
    })

    it('rejects an S- line outside Security', () => {
        const wrong = PLAN.replace('- [S-2]', '- [BASELINE]')
        expect(() => parsePlanLines(wrong, 'v')).toThrow(/BASELINE: duplicate/)
        const moved = PLAN.replace('- [BASELINE] Run', '- [S-9] Run')
        expect(() => parsePlanLines(moved, 'v')).toThrow(/S-9: an S- line belongs in Security/)
    })

    it('rejects a line with no title or no steps', () => {
        const bare = PLAN.replace(
            '- [S-2] No secrets in Sentry — read the Sentry scrubbing config',
            '- [S-2] No secrets'
        )
        expect(() => parsePlanLines(bare, 'v')).toThrow(/S-2: needs "<title> — <steps>"/)
    })

    it.each([
        ['an indented bullet', '- [S-2]', '  - [S-2]'],
        ['a * bullet', '- [S-2]', '* [S-2]'],
        ['a lowercase id', '- [S-2]', '- [s-2]'],
        ['an indented Changes line', '- 1.1 Old', '  - 1.1 Old'],
    ])('rejects %s instead of dropping it', (_name, from, to) => {
        const bad = PLAN.replace(from, to)
        expect(() => parsePlanLines(bad, 'v')).toThrow(/a test line is/)
    })

    it('reads CRLF input the same as LF', () => {
        const crlf = PLAN.replace(/\n/g, '\r\n')
        expect(parsePlanLines(crlf, 'v').lines).toEqual(parsePlanLines(PLAN, 'v').lines)
    })

    it('collects every problem into the error', () => {
        const bad = PLAN.replace('- 2.1 New', '- 1.1 New').replace(
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
