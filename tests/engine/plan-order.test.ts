import { describe, expect, it } from 'vitest'
import { parsePlanLines } from '@/engine/plan-lines'
import {
    type ChangeLine,
    orderChanges,
    PlanOrderError,
    type Role,
    type RunGroup,
    type RunItem,
    reorderPlan,
} from '@/engine/plan-order'

function line(
    title: string,
    role: Role,
    needs: string,
    extra: Partial<ChangeLine> = {}
): ChangeLine {
    return { title, steps: 's', pr: 1, stagingOnly: false, endsStudy: false, role, needs, ...extra }
}

const groups = (items: RunItem[]) => items.filter((i): i is RunGroup => i.kind === 'group')
const notes = (items: RunItem[]) => items.filter(i => i.kind === 'note').map(i => i.text)
const shape = (items: RunItem[]) =>
    groups(items).map(
        g =>
            `${g.role}@${g.needs}${g.newStudy ? '+new' : ''}:${g.lines.map(l => l.title).join(',')}`
    )

describe('orderChanges', () => {
    it('groups checks with no study by role and ends on the researcher who starts the study', () => {
        const items = orderChanges([
            line('a', 'researcher', 'none'),
            line('b', 'reviewer', 'none'),
            line('c', 'researcher', 'none'),
            line('d', 'admin', 'none'),
            line('e', 'reviewer', 'proposal-submitted'),
        ])
        expect(shape(items)).toEqual([
            'admin@none:d',
            'reviewer@none:b',
            'researcher@none:a,c',
            'reviewer@proposal-submitted:e',
        ])
    })

    it('moves one study through the stages, in lifecycle order, whatever the input order', () => {
        const items = orderChanges([
            line('results', 'researcher', 'results-approved'),
            line('review', 'reviewer', 'proposal-submitted'),
            line('draft', 'researcher', 'proposal-draft'),
        ])
        expect(shape(items)).toEqual([
            'researcher@proposal-draft:draft',
            'reviewer@proposal-submitted:review',
            'researcher@results-approved:results',
        ])
        expect(notes(items)).toEqual([
            'Next: as researcher, start a new study proposal with a natural title and description, and leave it as a draft.',
            'Next: as researcher, submit the proposal.',
            'Next: as reviewer, approve the proposal; then as researcher, upload the study code and submit it; then as reviewer, approve the code, then wait for the run to finish and the results to show, then approve the results.',
            expect.stringMatching(/^Last: as admin, delete every study/),
        ])
    })

    it('at a stage, starts as the role signed in and ends as the role that moves the study on', () => {
        // The reviewer approves the proposal, so the researcher check goes first.
        const items = orderChanges([
            line('rev', 'reviewer', 'proposal-submitted'),
            line('adm', 'admin', 'proposal-submitted'),
            line('res', 'researcher', 'proposal-submitted'),
            line('later', 'researcher', 'proposal-approved'),
        ])
        expect(shape(items)).toEqual([
            'researcher@proposal-submitted:res',
            'admin@proposal-submitted:adm',
            'reviewer@proposal-submitted:rev',
            'researcher@proposal-approved:later',
        ])
    })

    it('enters the code-changes stage only when a check needs it', () => {
        const skip = orderChanges([line('x', 'reviewer', 'code-approved')])
        expect(notes(skip)[0]).toMatch(
            /upload the study code and submit it; then as reviewer, approve the code\.$/
        )
        expect(notes(skip)[0]).not.toMatch(/request changes|resubmit/)

        const detour = orderChanges([
            line('x', 'reviewer', 'code-approved'),
            line('y', 'researcher', 'code-changes-requested'),
        ])
        expect(shape(detour)).toEqual([
            'researcher@code-changes-requested:y',
            'reviewer@code-approved:x',
        ])
        expect(notes(detour)[1]).toBe(
            'Next: as researcher, resubmit the code; then as reviewer, approve the code.'
        )
    })

    it('runs one check that ends the study last, and gives each other one a new study', () => {
        const items = orderChanges([
            line('reject', 'reviewer', 'proposal-submitted', { endsStudy: true }),
            line('delete', 'admin', 'proposal-approved', { endsStudy: true }),
            line('view', 'researcher', 'proposal-draft'),
        ])
        expect(shape(items)).toEqual([
            'researcher@proposal-draft:view',
            'reviewer@proposal-submitted:reject',
            'admin@proposal-approved+new:delete',
        ])
        expect(notes(items)[2]).toMatch(/^Next, with a new study: as researcher, start a new study/)
    })

    it('keeps a stage group of the same role together with the check that ends the study', () => {
        const items = orderChanges([
            line('reject', 'reviewer', 'proposal-submitted', { endsStudy: true }),
            line('look', 'reviewer', 'proposal-submitted'),
        ])
        expect(shape(items)).toEqual(['reviewer@proposal-submitted:look,reject'])
    })

    it('adds no study steps when no check needs a study', () => {
        const items = orderChanges([line('a', 'reviewer', 'none'), line('b', 'researcher', 'none')])
        expect(shape(items)).toEqual(['reviewer@none:a', 'researcher@none:b'])
        expect(notes(items)).toEqual([])
    })
})

const PLAN = `# Regression plan v1

## Summary
Words with a [link](https://example.com).

## Baseline
- [BASELINE] Run release-happy-path — the QA Runner runs it

## Changes
### 1. Reviewer · study with a submitted proposal
- 1.1 Review shows the PI — open the study ([PR #7](https://github.com/x/y/pull/7))
### 2. Researcher · no study
- Dashboard loads — open the dashboard (PR #8)
### 3. Reviewer · no study
- 3.1 Orgs list loads — open orgs (staging only) ([PR #9](https://github.com/x/y/pull/9))

## Security
- [S-1] t — p (staging only)

## Technical appendix
### #7 x
Files.
`

describe('reorderPlan', () => {
    const out = reorderPlan(PLAN, 'safeinsights/management-app')

    it('rewrites Changes in run order, numbered, with every PR linked', () => {
        const changes = out.slice(out.indexOf('## Changes'), out.indexOf('## Security'))
        expect(changes).toBe(`## Changes

### 1. Reviewer · no study
- 1.1 Orgs list loads — open orgs (staging only) ([PR #9](https://github.com/safeinsights/management-app/pull/9))

### 2. Researcher · no study
- 2.1 Dashboard loads — open the dashboard ([PR #8](https://github.com/safeinsights/management-app/pull/8))

> Next: as researcher, start a new study proposal with a natural title and description, and leave it as a draft, then submit the proposal.

### 3. Reviewer · study with a submitted proposal
- 3.1 Review shows the PI — open the study ([PR #7](https://github.com/safeinsights/management-app/pull/7))

> Last: as admin, delete every study and user this run created, with the QA cleanup API (\`qar cleanup\`).

`)
    })

    it('merges the actions of one role into one sentence part', () => {
        // "as researcher, A; then as researcher, B" would read as two sign-ins.
        expect(out).toMatch(/as researcher, start [^;]*, then submit the proposal\./)
    })

    it('leaves every other section as it was', () => {
        expect(out.slice(0, out.indexOf('## Changes'))).toBe(
            PLAN.slice(0, PLAN.indexOf('## Changes'))
        )
        expect(out.slice(out.indexOf('## Security'))).toBe(PLAN.slice(PLAN.indexOf('## Security')))
    })

    it('gives a plan that plan-lines accepts, and is stable when run again', () => {
        expect(() => parsePlanLines(out, 'v1', { prs: [7, 8, 9] })).not.toThrow()
        expect(reorderPlan(out, 'safeinsights/management-app')).toBe(out)
    })

    it('keeps CRLF line endings', () => {
        const crlf = reorderPlan(PLAN.replace(/\n/g, '\r\n'), 'safeinsights/management-app')
        expect(crlf.replace(/\r\n/g, '\n')).toBe(out)
        expect(
            crlf.split('\n').every((l, i, all) => i === all.length - 1 || l.endsWith('\r'))
        ).toBe(true)
    })

    it('refuses, naming the line, when Changes holds anything it would drop', () => {
        const prose = PLAN.replace(
            '### 2. Researcher',
            'Remember to clear the cache.\n### 2. Researcher'
        )
        expect(() => reorderPlan(prose, 'o/r')).toThrow(PlanOrderError)
        expect(() => reorderPlan(prose, 'o/r')).toThrow(/Remember to clear the cache/)
    })

    it('refuses a line outside any group', () => {
        const loose = PLAN.replace('### 1. Reviewer · study with a submitted proposal\n', '')
        expect(() => reorderPlan(loose, 'o/r')).toThrow(
            /Review shows the PI: is not under a run group heading/
        )
    })
})
