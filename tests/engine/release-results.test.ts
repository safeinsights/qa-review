import { describe, expect, it } from 'vitest'
import type { Inventory } from '@/engine/inventory'
import { renderResults, secretValues } from '@/engine/release-results'

const plan: Inventory = {
    card: 'v1.6.9',
    target: 'release',
    lines: [
        {
            id: 'BASELINE',
            title: 'Run release-happy-path',
            kind: 'check',
            text: 'x',
            source: { type: 'card', ref: 'plan' },
            section: 'baseline',
        },
        {
            id: 'R-1110-1',
            title: 'Old studies show the pill',
            kind: 'check',
            text: 'x',
            source: { type: 'card', ref: 'plan' },
            section: 'changes',
            pr: 1110,
        },
        {
            id: 'S-1',
            title: 'Signin redirect',
            kind: 'check',
            text: 'x',
            source: { type: 'card', ref: 'plan' },
            section: 'security',
            stagingOnly: true,
        },
    ],
}

describe('renderResults', () => {
    it('writes counts, one row per line grouped by section, and redacts secrets', () => {
        const md = renderResults({
            tag: 'v1.6.9',
            env: 'production',
            plan,
            results: [
                {
                    id: 'BASELINE',
                    result: 'FAIL',
                    evidence: 'step "Launch the IDE" failed',
                    severity: 'major',
                    area: 'ide',
                },
                { id: 'R-1110-1', result: 'PASS', evidence: 'pill visible; password was hunter2' },
                { id: 'S-1', result: 'NOT TESTED', evidence: 'staging only', approvedBy: 'plan' },
            ],
            secrets: ['hunter2'],
            now: new Date(2026, 9, 26, 14, 5),
        })
        expect(md).toContain('# Regression results v1.6.9 — production')
        expect(md).toContain('2026-10-26 14:05')
        expect(md).toContain('PASS 1 · FAIL 1 · NOT TESTED 1')
        expect(md).toContain('## Baseline')
        expect(md).toContain(
            '| BASELINE | Run release-happy-path | FAIL (major, ide) | step "Launch the IDE" failed |'
        )
        expect(md).toContain('## Changes')
        expect(md).toContain('### #1110')
        expect(md).toContain('## Security')
        expect(md).not.toContain('hunter2')
        expect(md).toContain('[redacted]')
    })

    it('lists a line with no result as MISSING so the gap is visible', () => {
        const md = renderResults({
            tag: 'v',
            env: 'staging',
            plan,
            results: [],
            secrets: [],
            now: new Date(),
        })
        expect(md.match(/MISSING/g)).toHaveLength(3)
    })
})

describe('renderResults edge cases', () => {
    const base = { tag: 'v', env: 'staging', secrets: [] as string[], now: new Date() }
    const line = (o: object) => ({
        id: 'X',
        title: 'T',
        kind: 'check',
        text: 'x',
        source: { type: 'card', ref: 'plan' },
        ...o,
    })
    const mk = (lines: object[]) =>
        ({ card: 'v', target: 'release', lines }) as unknown as Inventory

    it('redacts the longest secret first', () => {
        const md = renderResults({
            ...base,
            plan,
            results: [{ id: 'R-1110-1', result: 'PASS', evidence: 'pw hunter2' }],
            secrets: ['hunter', 'hunter2'],
        })
        expect(md).not.toContain('hunter')
    })

    it('ignores empty secrets', () => {
        const md = renderResults({
            ...base,
            plan,
            results: [{ id: 'R-1110-1', result: 'PASS', evidence: 'abc' }],
            secrets: [''],
        })
        expect(md).toContain('| abc |')
    })

    it('lists results not in the plan', () => {
        const md = renderResults({
            ...base,
            plan,
            results: [{ id: 'STRAY', result: 'PASS', evidence: 'e' }],
        })
        expect(md).toContain('## Unplanned results')
        expect(md).toContain('| STRAY |  | PASS | e |')
        expect(md).toContain('UNPLANNED 1')
    })

    it('shows lines with an unknown section under Other', () => {
        const md = renderResults({
            ...base,
            plan: mk([line({ id: 'O-1', section: undefined })]),
            results: [],
        })
        expect(md).toContain('## Other')
        expect(md).toContain('| O-1 |')
    })

    it('groups changes without a PR after the numbered ones', () => {
        const md = renderResults({
            ...base,
            plan: mk([
                line({ id: 'C-0', section: 'changes' }),
                line({ id: 'C-1', section: 'changes', pr: 5 }),
            ]),
            results: [],
        })
        expect(md).not.toContain('#undefined')
        expect(md.indexOf('### #5')).toBeLessThan(md.indexOf('### (no PR)'))
    })

    it('treats an unknown result value as no result', () => {
        const md = renderResults({
            ...base,
            plan: mk([line({ id: 'U-1', section: 'baseline' })]),
            results: [{ id: 'U-1', result: 'MAYBE', evidence: 'e' } as never],
        })
        expect(md).toContain('MISSING (unknown result "MAYBE")')
        expect(md).toContain('NO RESULT 1')
    })
})

describe('secretValues', () => {
    it('collects password and MFA values only', () => {
        expect(
            secretValues({
                ADMIN_PASSWORD_STAGING: 'p',
                ADMIN_MFA_SEED_STAGING: 's',
                QA_BASE_URL: 'u',
                EMPTY_PASSWORD: '',
            })
        ).toEqual(['p', 's'])
    })
})
