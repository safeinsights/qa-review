import { describe, expect, it } from 'vitest'
import type { Inventory } from '@/engine/inventory'
import { checkResults, type ResultEntry } from '@/engine/results'

const inventory: Inventory = {
    card: 'OTTER-1',
    target: 'qa',
    lines: [
        {
            id: 'A.1',
            title: 'A one',
            kind: 'check',
            text: 'a',
            source: { type: 'card', ref: 'description' },
        },
        {
            id: 'A.2',
            title: 'A two',
            kind: 'check',
            text: 'b',
            source: { type: 'card', ref: 'description' },
            conflictWith: 'A.2-figma',
        },
        {
            id: 'A.2-figma',
            title: 'A two (Figma)',
            kind: 'check',
            text: 'b2',
            source: { type: 'figma', ref: 'Page / Frame' },
            conflictWith: 'A.2',
        },
        {
            id: 'N.1',
            title: 'No button',
            kind: 'absence',
            text: 'no button',
            source: { type: 'figma', ref: 'x' },
        },
        {
            id: 'C.1',
            title: 'Note',
            kind: 'context',
            text: 'note',
            source: { type: 'figma', ref: 'x' },
        },
        {
            id: 'OBS.1',
            title: 'Seen',
            kind: 'check',
            text: 'seen',
            source: { type: 'observed', ref: 'RL dashboard' },
        },
    ],
}

const good: ResultEntry[] = [
    { id: 'A.1', result: 'PASS', evidence: 'cell shows "Openstax"' },
    { id: 'A.2', result: 'PASS', evidence: 'app follows the card' },
    { id: 'A.2-figma', result: 'CONFLICT', evidence: 'app follows the card, not this note' },
    { id: 'N.1', result: 'PASS', evidence: 'no button rendered' },
    {
        id: 'OBS.1',
        result: 'FAIL',
        severity: 'minor',
        area: 'layout',
        evidence: '.tmp/OTTER-1-shot.png',
    },
]

function problems(results: ResultEntry[]): string[] {
    return checkResults(inventory, results).problems
}

describe('checkResults', () => {
    it('accepts a complete, evidenced set and counts results', () => {
        const report = checkResults(inventory, good)
        expect(report.problems).toEqual([])
        expect(report.ok).toBe(true)
        expect(report.counts).toEqual({
            PASS: 3,
            FAIL: 1,
            CONFLICT: 1,
            UNCLEAR: 0,
            'NOT TESTED': 0,
        })
    })

    // The report names lines by title, not id, so a reader does not need the
    // inventory open to follow it. A line without one cannot be reported.
    it('requires a title on every line', () => {
        const noTitle = {
            ...inventory,
            lines: inventory.lines.map(l => ({ ...l, title: l.id === 'A.1' ? '' : l.title })),
        }
        expect(checkResults(noTitle, good).problems).toEqual(['A.1: no title'])
    })

    it('names every check or absence line that has no result', () => {
        expect(problems(good.filter(r => r.id !== 'A.1'))).toEqual(['A.1: no result'])
    })

    it('does not require a result for a context line', () => {
        expect(problems(good)).toEqual([])
    })

    it('rejects duplicate inventory ids so one result cannot cover two lines', () => {
        const dup = {
            ...inventory,
            lines: [...inventory.lines, { ...inventory.lines[5], kind: 'check' as const }],
        }
        expect(checkResults(dup, good).problems).toContain('OBS.1: duplicate inventory id')
    })

    it('rejects an observed line that is context', () => {
        const ctx = {
            ...inventory,
            lines: inventory.lines.map(l =>
                l.id === 'OBS.1' ? { ...l, kind: 'context' as const } : l
            ),
        }
        expect(
            checkResults(
                ctx,
                good.filter(r => r.id !== 'OBS.1')
            ).problems
        ).toEqual(['OBS.1: an observed line cannot be context (it can only be a FAIL)'])
    })

    it('rejects a result for an id that is not in the inventory', () => {
        const extra = [...good, { id: 'ZZ.9', result: 'PASS' as const, evidence: 'x' }]
        expect(problems(extra)).toEqual(['ZZ.9: not in the inventory'])
    })

    it('rejects a duplicate result', () => {
        expect(problems([...good, good[0]])).toEqual(['A.1: more than one result'])
    })

    it('rejects an unknown result value', () => {
        const bad = good.map(r => (r.id === 'A.1' ? { ...r, result: 'MAYBE' } : r))
        expect(problems(bad as ResultEntry[])).toEqual(['A.1: unknown result "MAYBE"'])
    })

    it('requires evidence on every result', () => {
        const bad = good.map(r => (r.id === 'A.1' ? { ...r, evidence: ' ' } : r))
        expect(problems(bad)).toEqual(['A.1: no evidence'])
    })

    it('requires severity and area on a FAIL', () => {
        const bad = good.map(r =>
            r.id === 'OBS.1' ? { id: r.id, result: r.result, evidence: r.evidence } : r
        )
        expect(problems(bad)).toEqual([
            'OBS.1: FAIL needs a severity (blocker, major, minor)',
            'OBS.1: FAIL needs an area',
        ])
    })

    it('requires the user to have approved a NOT TESTED line', () => {
        const bad = good.map(r =>
            r.id === 'A.1'
                ? { id: r.id, result: 'NOT TESTED' as const, evidence: 'needs enclave' }
                : r
        )
        expect(problems(bad)).toEqual(['A.1: NOT TESTED needs approvedBy'])
    })

    it('requires an observed line to be a FAIL', () => {
        const bad = good.map(r => (r.id === 'OBS.1' ? { ...r, result: 'PASS' as const } : r))
        expect(problems(bad)).toEqual(['OBS.1: an observed line can only be a FAIL'])
    })

    // The card is the spec. In a conflict pair the card line is checked against the
    // app (PASS or FAIL) and the Figma line records the discrepancy as CONFLICT.
    it('checks the card side of a conflict pair and marks the Figma side CONFLICT', () => {
        const bad = good.map(r => {
            if (r.id === 'A.2') return { ...r, result: 'CONFLICT' as const }
            if (r.id === 'A.2-figma') return { ...r, result: 'PASS' as const }
            if (r.id === 'A.1') return { ...r, result: 'CONFLICT' as const }
            return r
        })
        expect(problems(bad)).toEqual([
            'A.1: CONFLICT but the line has no conflictWith',
            'A.2: the card side of a conflict is checked against the app: PASS or FAIL',
            'A.2-figma: the Figma side of a conflict must be CONFLICT',
        ])
    })

    function withLines(edit: (id: string) => string | undefined): Inventory {
        return {
            ...inventory,
            lines: inventory.lines.map(l => {
                const conflictWith = edit(l.id)
                return conflictWith === undefined ? l : { ...l, conflictWith }
            }),
        }
    }

    // An observed line must FAIL and a non-card side of a pair must be CONFLICT, so
    // no result could ever pass; the inventory itself is named as the problem.
    it('rejects an observed line in a conflict pair once, whatever its result', () => {
        const inv = withLines(id => (id === 'OBS.1' ? 'A.1' : id === 'A.1' ? 'OBS.1' : undefined))
        for (const result of ['FAIL', 'CONFLICT'] as const) {
            const results = good.map(r => (r.id === 'OBS.1' ? { ...r, result } : r))
            expect(checkResults(inv, results).problems).toContain(
                'OBS.1: an observed line cannot be in a conflict (it can only be a FAIL)'
            )
        }
        expect(checkResults(inv, good).problems).toEqual([
            'OBS.1: an observed line cannot be in a conflict (it can only be a FAIL)',
        ])
    })

    it('rejects a conflictWith that is missing, one-sided, or self-referential', () => {
        const missing = withLines(id => (id === 'A.2' ? 'ZZ.9' : undefined))
        expect(checkResults(missing, good).problems).toEqual([
            'A.2: conflictWith "ZZ.9" is not in the inventory',
            'A.2-figma: conflictWith "A.2" does not point back at A.2-figma',
        ])
        const self = withLines(id => (id === 'A.2' ? 'A.2' : undefined))
        expect(checkResults(self, good).problems).toContain('A.2: conflictWith points at itself')
    })
})

describe('the production rule for staging-only lines', () => {
    const plan: Inventory = {
        card: 'v1',
        target: 'release',
        lines: [
            {
                id: 'S-1',
                title: 'Probe',
                kind: 'check',
                text: 'x',
                source: { type: 'card', ref: 'plan' },
                stagingOnly: true,
            },
        ],
    }
    it('rejects PASS or FAIL on production', () => {
        const r = checkResults(plan, [{ id: 'S-1', result: 'PASS', evidence: 'e' }], {
            env: 'production',
        })
        expect(r.problems).toEqual([
            'S-1: a (staging only) line cannot be PASS or FAIL on production',
        ])
    })
    it('accepts NOT TESTED on production and PASS on staging', () => {
        expect(
            checkResults(
                plan,
                [{ id: 'S-1', result: 'NOT TESTED', evidence: 'e', approvedBy: 'plan' }],
                { env: 'production' }
            ).ok
        ).toBe(true)
        expect(
            checkResults(plan, [{ id: 'S-1', result: 'PASS', evidence: 'e' }], { env: 'staging' })
                .ok
        ).toBe(true)
    })
})
