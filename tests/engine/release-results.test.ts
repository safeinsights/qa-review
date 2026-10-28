import { describe, expect, it } from 'vitest'
import type { Inventory } from '@/engine/inventory'
import { renderResults, renderSecurityResults, secretValues } from '@/engine/release-results'

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
            publicOnly: false,
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
            publicOnly: false,
        })
        expect(md.match(/MISSING/g)).toHaveLength(3)
    })
})

describe('the public asset and the local security file', () => {
    const input = {
        tag: 'v1.6.9',
        env: 'staging',
        plan,
        results: [
            { id: 'BASELINE', result: 'PASS' as const, evidence: 'report' },
            { id: 'R-1110-1', result: 'PASS' as const, evidence: 'pill' },
            {
                id: 'S-1',
                result: 'FAIL' as const,
                evidence: 'redirect followed; token abc',
                severity: 'major' as const,
                area: 'auth',
            },
            { id: 'S-9', result: 'PASS' as const, evidence: 'unplanned probe' },
        ],
        secrets: ['abc'],
        now: new Date(2026, 9, 26, 14, 5),
    }

    it('publicOnly drops every S- row, the Security section, and their counts', () => {
        const md = renderResults({ ...input, publicOnly: true })
        expect(md).not.toMatch(/S-1|S-9|## Security|FAIL/)
        expect(md).toMatch(/PASS 2$/m)
        expect(md).not.toContain('UNPLANNED')
    })

    it('the security file holds only the S- rows, in the same table, redacted', () => {
        const md = renderSecurityResults(input)
        expect(md).toContain('# Security results v1.6.9 — staging')
        expect(md).toContain('## Security')
        expect(md).toContain(
            '| S-1 | Signin redirect | FAIL (major, auth) | redirect followed; token [redacted] |'
        )
        expect(md).toContain('| S-9 |')
        expect(md).not.toMatch(/R-1110-1|BASELINE/)
    })
})

describe('renderResults edge cases', () => {
    const base = {
        tag: 'v',
        env: 'staging',
        secrets: [] as string[],
        now: new Date(),
        publicOnly: false,
    }
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
    it('collects password, MFA, private key, token and secret values only', () => {
        expect(
            secretValues({
                ADMIN_PASSWORD_STAGING: 'p',
                ADMIN_MFA_SEED_STAGING: 's',
                REVIEWER_RESULTS_PRIVATE_KEY_QA: 'k',
                JIRA_API_TOKEN: 't',
                CLERK_SECRET: 'c',
                QA_BASE_URL: 'u',
                JIRA_USERNAME: 'n',
                EMPTY_PASSWORD: '',
            })
        ).toEqual(['p', 's', 'k', 't', 'c'])
    })
})
