import { describe, expect, it } from 'vitest'
import { folderIdFrom } from '@/engine/confluence'
import type { Inventory } from '@/engine/inventory'
import { buildRunPage, cleanEvidence, prCards, shotsIn } from '@/engine/release-confluence'
import { STOPPED_EVIDENCE } from '@/engine/release-run-log'
import type { ResultEntry } from '@/engine/results'

const pr1170 = { pr: 1170, prUrl: 'https://github.com/o/r/pull/1170' }
const pr1175 = { pr: 1175, prUrl: 'https://github.com/o/r/pull/1175' }
const admin = { section: 'changes', role: 'admin', needs: 'none' }

const plan = {
    card: 'v1.7.0',
    target: 'release',
    lines: [
        { id: 'BASELINE', title: 'Run release-happy-path', section: 'baseline' },
        { id: '1.1', title: 'HSTS header', ...admin, ...pr1170 },
        { id: '1.21', title: 'Centred sort columns', ...admin, ...pr1175 },
        { id: '1.22', title: 'Legal tab gap & <width>', ...admin, ...pr1175 },
        {
            id: '4.2',
            title: 'Own edit leaves no dot',
            section: 'changes',
            role: 'researcher',
            needs: 'proposal-draft',
            ...pr1175,
        },
        { id: 'S-1', title: 'Gate on code submission', section: 'security' },
    ],
} as unknown as Inventory

const results: ResultEntry[] = [
    { id: 'BASELINE', result: 'PASS', evidence: 'All 34 steps passed.' },
    {
        id: '1.1',
        result: 'PASS',
        evidence: 'HSTS sent. Screenshot .tmp/release/v1.7.0/shots/1.1.png',
    },
    {
        id: '1.21',
        result: 'FAIL',
        severity: 'minor',
        area: 'SI admin tables',
        evidence:
            'Counts sort as text, password hunter2 seen. Screenshot .tmp/release/v1.7.0/shots/1.21-users-sort.png',
    },
    {
        id: '1.22',
        result: 'PASS',
        evidence: 'Gap 32px. Screenshots shots/1.22.png, shots/missing.png',
    },
    { id: '4.2', result: 'NOT TESTED', approvedBy: 'Runner', evidence: STOPPED_EVIDENCE },
    { id: 'S-1', result: 'NOT TESTED', approvedBy: 'Runner', evidence: STOPPED_EVIDENCE },
]

const page = buildRunPage({
    tag: 'v1.7.0',
    env: 'staging',
    plan,
    results,
    secrets: ['hunter2'],
    now: new Date(2026, 9, 28, 14, 5),
    releaseUrl: 'https://github.com/o/r/releases/tag/v1.7.0',
    prs: [
        { number: 1170, title: 'OTTER-678 Add HSTS header', jiraKeys: ['OTTER-678'] },
        { number: 1175, title: 'Show the sort icon beside the label', jiraKeys: ['OTTER-801'] },
    ],
    boards: ['OTTER'],
    shotExists: name => name !== 'missing.png',
})

describe('buildRunPage', () => {
    it('names the run page by tag, env and time', () => {
        expect(page.title).toBe('v1.7.0 staging — 2026-10-28 14:05 run')
    })

    it('attaches and shows each screenshot that exists, once', () => {
        expect(page.images.sort()).toEqual(['1.1.png', '1.21-users-sort.png', '1.22.png'])
        expect(page.storage).toContain('<ri:attachment ri:filename="1.21-users-sort.png" />')
        expect(page.storage).not.toContain('missing.png" />')
    })

    it('keeps the runner-machine paths out of the text', () => {
        expect(page.storage).not.toContain('.tmp/release')
        expect(page.storage).not.toMatch(/Screenshots? shots\//)
    })

    it('puts each failure first, as its own block, and links the cards of their PRs', () => {
        expect(page.storage.indexOf('<h2>Failures (1)</h2>')).toBeGreaterThan(-1)
        expect(page.storage.indexOf('<h2>Failures (1)</h2>')).toBeLessThan(
            page.storage.indexOf('<h2>Results by run group</h2>')
        )
        expect(page.storage).toContain('<h3>1.21 · Centred sort columns</h3>')
        expect(page.failCards).toEqual(['OTTER-801'])
    })

    it('collapses the tested lines by run group, with set column widths', () => {
        expect(page.storage).toMatch(
            /ac:name="expand"><ac:parameter ac:name="title">1 · Admin · no study — 2 PASS, 1 FAIL</
        )
        expect(page.storage).toContain('<col style="width: 370.0px;" />')
    })

    it('lists the lines a stopped run never reached on their own, not in the groups', () => {
        expect(page.storage).not.toContain('Researcher · study: proposal draft')
        expect(page.storage).toContain('2 lines the run did not reach')
        expect(page.storage).toContain('None of the 1 security lines was reached.')
    })

    it('escapes text and redacts secrets', () => {
        expect(page.storage).toContain('Legal tab gap &amp; &lt;width&gt;')
        expect(page.storage).not.toContain('hunter2')
        expect(page.storage).toContain('[redacted]')
    })

    it('shows each result as a status lozenge', () => {
        expect(page.storage).toContain(
            '<ac:parameter ac:name="colour">Red</ac:parameter><ac:parameter ac:name="title">FAIL</ac:parameter>'
        )
    })
})

describe('cleanEvidence', () => {
    it('drops the screenshot mentions and keeps the rest', () => {
        expect(
            cleanEvidence(
                'Gap 32px. Screenshots .tmp/release/v1/shots/a.png, shots/b.png and done.'
            )
        ).toBe('Gap 32px. and done.')
    })
})

describe('shotsIn', () => {
    it('finds both path forms and drops duplicates', () => {
        expect(shotsIn('a .tmp/release/v1/shots/x.png, shots/y.jpg and shots/x.png')).toEqual([
            'x.png',
            'y.jpg',
        ])
    })
})

describe('prCards', () => {
    it('prefers the keys in the title over keys the description mentions', () => {
        expect(
            prCards({ title: 'OTTER-698 follow-up', jiraKeys: ['OTTER-698', 'OTTER-746'] })
        ).toEqual(['OTTER-698'])
        expect(prCards({ title: 'Bump vite', jiraKeys: ['OTTER-5', 'OTTER-6'] })).toEqual([
            'OTTER-5',
        ])
        expect(prCards({ title: 'Bump vite' })).toEqual([])
    })

    it('takes only keys on our boards', () => {
        expect(
            prCards({ title: 'Sort icon', jiraKeys: ['ABC-341', 'OTTER-801'] }, ['OTTER'])
        ).toEqual(['OTTER-801'])
        expect(prCards({ title: 'ABC-1 thing', jiraKeys: [] }, ['OTTER'])).toEqual([])
    })
})

describe('folderIdFrom', () => {
    it('takes a folder id or a folder URL', () => {
        expect(folderIdFrom('3667755009')).toBe('3667755009')
        expect(
            folderIdFrom(
                'https://openstax.atlassian.net/wiki/spaces/SafeInsights/folder/3667755009'
            )
        ).toBe('3667755009')
        expect(() => folderIdFrom('SafeInsights')).toThrow(/not a Confluence folder/)
    })
})

describe('the testing plan on the page', () => {
    it('links each attached plan file near the top', () => {
        const withPlan = buildRunPage({
            tag: 'v1.7.0',
            env: 'staging',
            plan,
            results,
            secrets: [],
            now: new Date(2026, 9, 28, 14, 5),
            planFiles: [{ name: 'testing-plan.md', label: 'the plan as run' }],
            shotExists: () => false,
        })
        expect(withPlan.storage).toContain(
            '<ri:attachment ri:filename="testing-plan.md" /><ac:plain-text-link-body><![CDATA[testing-plan.md]]>'
        )
        expect(withPlan.storage.indexOf('<h2>Testing plan</h2>')).toBeLessThan(
            withPlan.storage.indexOf('<h2>Failures (1)</h2>')
        )
    })
})
