import { describe, expect, it } from 'vitest'
import {
    describeViolations,
    loadAxeSource,
    type PageScan,
    withInserts,
} from '@/engine/flows/accessibility'
import { accessibilitySuite } from '@/suites/accessibility'
import { accessibilityAgreementsSuite } from '@/suites/accessibility-agreements'
import { accessibilityDecisionsSuite } from '@/suites/accessibility-decisions'
import { accessibilityLifecycleSuite } from '@/suites/accessibility-lifecycle'
import { accessibilityOnboardingSuite } from '@/suites/accessibility-onboarding'
import type { Step } from '@/suites/types'

const step = (name: string): Step => ({ name, run: async () => {} })
const names = (steps: Step[]) => steps.map(s => s.name)

describe('withInserts', () => {
    it('splices after the Nth step of a repeated name', () => {
        const base = [step('Switch'), step('A'), step('Switch'), step('B')]
        const out = withInserts(base, [{ after: 'Switch', occurrence: 2, steps: [step('Scan')] }])
        expect(names(out)).toEqual(['Switch', 'A', 'Switch', 'Scan', 'B'])
    })

    // A renamed step in the wrapped suite must break loudly, not drop a scan.
    it('throws naming a missing anchor', () => {
        expect(() => withInserts([step('A')], [{ after: 'Gone', steps: [step('Scan')] }])).toThrow(
            /No step #1 named "Gone"/
        )
    })
})

// pnpm does not hoist axe-core, so a bare resolve passes only in the npm-built app.
describe('loadAxeSource', () => {
    it('finds the axe-core that lighthouse depends on', () => {
        expect(loadAxeSource()).toContain('axe.run')
    })
})

describe('describeViolations', () => {
    it('names each rule and its first targets, counting the rest', () => {
        const scan: PageScan = {
            role: 'reviewer',
            route: '/openstax/study/x/review',
            label: 'study review',
            incomplete: [],
            violations: [
                {
                    id: 'aria-allowed-attr',
                    impact: 'critical',
                    help: 'Elements must only use supported ARIA attributes',
                    helpUrl: '',
                    tags: [],
                    nodes: ['#a', '#b', '#c', '#d'].map(t => ({ target: [t] })),
                },
            ],
        }
        expect(describeViolations(scan)).toBe(
            '1 WCAG A/AA violation(s) on study review (/openstax/study/x/review) as reviewer:\n' +
                '- aria-allowed-attr [critical] Elements must only use supported ARIA attributes: #a, #b, #c (+1 more)'
        )
    })
})

// Building these suites runs withInserts against the real wrapped suites, so this is
// what catches a happy-path step rename before a 30-minute run does.
describe('accessibility suites', () => {
    const suites = [
        accessibilitySuite,
        accessibilityLifecycleSuite,
        accessibilityDecisionsSuite,
        accessibilityAgreementsSuite,
        accessibilityOnboardingSuite,
    ]

    it('each ends with the conformance verdict', () => {
        for (const s of suites) expect(s.steps.at(-1)?.name).toBe('Check WCAG conformance')
    })

    // A retry reloads src/suites/<suite name>.ts, so the name must match the file.
    it('are named after their files', () => {
        expect(suites.map(s => s.name)).toEqual([
            'accessibility',
            'accessibility-lifecycle',
            'accessibility-decisions',
            'accessibility-agreements',
            'accessibility-onboarding',
        ])
    })
})
