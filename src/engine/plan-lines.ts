import type { Inventory, InventoryLine } from './inventory'
import { LINE_FORM, type ParsedHeading, parseChangeLine, parseGroupHeading } from './plan-order'

export const PLAN_SECTIONS = [
    'Summary',
    'Baseline',
    'Changes',
    'Security',
    'Technical appendix',
] as const
type SectionName = (typeof PLAN_SECTIONS)[number]

export class PlanLinesError extends Error {
    constructor(public readonly problems: string[]) {
        super(`plan-lines found ${problems.length} problem(s):\n${problems.join('\n')}`)
    }
}

const SECTION_HEADING = /^## (.+?)\s*$/
const TAGGED_LINE = /^- \[([A-Z]+(?:-\d+)*)\]\s*(.*)$/
const BULLET_WITH_TOKEN = /^\s*[-*+]\s*\[([^\]]+)\]/
const TEST_SECTIONS: readonly (SectionName | null)[] = ['Baseline', 'Security']
const STAGING_ONLY = /\s*\(staging only\)\s*$/i

function lineKindFor(id: string): 'baseline' | 'security' | null {
    if (id === 'BASELINE') return 'baseline'
    if (/^S-\d+$/.test(id)) return 'security'
    return null
}

const BULLET = /^\s*[-*+]\s/

// A Changes line is "<group>.<n> …" under a run group heading. The number is its
// place in the run, so it must match the group it sits in; `qar plan-order` renumbers
// after an edit.
function changesLine(
    raw: string,
    group: ParsedHeading | null,
    problems: string[]
): InventoryLine | null {
    const parsed = parseChangeLine(raw)
    if (parsed === null) {
        if (BULLET.test(raw))
            problems.push(`${raw.trim()}: a test line is "${LINE_FORM}" at column 0`)
        return null
    }
    if (typeof parsed === 'string') {
        problems.push(parsed)
        return null
    }
    const name = parsed.number ?? parsed.title
    if (!group) {
        problems.push(`${name}: is not under a run group heading`)
        return null
    }
    if (!parsed.number) {
        problems.push(`${name}: has no number — run qar plan-order`)
        return null
    }
    if (Number(parsed.number.split('.')[0]) !== group.number) {
        problems.push(`${name}: is under group ${group.number} — run qar plan-order`)
        return null
    }
    if (parsed.pr === undefined) {
        problems.push(`${name}: needs "([PR #<n>](<url>))" at the end`)
        return null
    }
    if (parsed.endsStudy && group.needs === 'none') {
        problems.push(`${name}: "(ends the study)" needs a group with a study`)
        return null
    }
    return {
        id: parsed.number,
        title: parsed.title,
        kind: 'check',
        text: parsed.steps,
        source: { type: 'card', ref: 'plan' },
        section: 'changes',
        pr: parsed.pr,
        prUrl: parsed.prUrl,
        stagingOnly: parsed.stagingOnly,
        role: group.role,
        needs: group.needs,
        endsStudy: parsed.endsStudy,
    }
}

// Security is the one optional section: the public asset (testing-plan.md) is the
// plan with it removed, and a run parses that asset.
const OPTIONAL_SECTIONS: readonly SectionName[] = ['Security']

export interface PlanLinesOptions {
    // The PR numbers of the release (prs.json). Given, every PR needs a Changes line
    // and every Changes line needs a PR in the release.
    prs?: number[]
}

// The completeness gate: the plan is the release's test list, so a PR with no line is
// a hole in it, and a line for a PR outside the release tests the wrong build.
export function completenessProblems(lines: InventoryLine[], prs: number[]): string[] {
    const problems: string[] = []
    const covered = new Set(lines.filter(l => l.section === 'changes').map(l => l.pr))
    for (const n of prs) if (!covered.has(n)) problems.push(`PR #${n} has no test line`)
    const inRelease = new Set(prs)
    for (const l of lines) {
        if (l.section === 'changes' && l.pr !== undefined && !inRelease.has(l.pr)) {
            problems.push(`${l.id} ${l.title}: PR #${l.pr} is not in the release`)
        }
    }
    return problems
}

// The markdown is the single source: this reads the [ID] lines out of it so the
// user can edit the plan freely and the results gate still has a list to check.
export function parsePlanLines(
    markdown: string,
    tag: string,
    options: PlanLinesOptions = {}
): Inventory {
    const problems: string[] = []
    const lines: InventoryLine[] = []
    const seenSections: string[] = []
    let section: SectionName | null = null
    let group: ParsedHeading | null = null
    const ids = new Set<string>()
    const addId = (id: string): boolean => {
        if (ids.has(id)) {
            problems.push(`${id}: duplicate id`)
            return false
        }
        ids.add(id)
        return true
    }

    for (const raw of markdown.split(/\r?\n/)) {
        const heading = SECTION_HEADING.exec(raw)
        if (heading) {
            const name = heading[1]
            if ((PLAN_SECTIONS as readonly string[]).includes(name)) {
                section = name as SectionName
                seenSections.push(name)
                group = null
            }
            continue
        }
        if (section === 'Changes') {
            const heading = parseGroupHeading(raw)
            if (typeof heading === 'string') {
                problems.push(heading)
                group = null
                continue
            }
            if (heading) {
                group = heading
                continue
            }
            const line = changesLine(raw, group, problems)
            if (line && addId(line.id)) lines.push(line)
            continue
        }
        const tagged = TAGGED_LINE.exec(raw)
        if (!tagged) {
            // A test line that fails the strict form would otherwise vanish from the
            // inventory, and results-check could never ask for its result.
            if (TEST_SECTIONS.includes(section) && BULLET_WITH_TOKEN.test(raw)) {
                problems.push(
                    `${raw.trim()}: a test line is "- [ID] <title> — <steps>" at column 0`
                )
            }
            continue
        }
        const id = tagged[1]
        let rest = tagged[2]
        if (!addId(id)) continue
        const kind = lineKindFor(id)
        if (!kind) {
            problems.push(`${id}: ids in Baseline and Security are BASELINE or S-<n>`)
            continue
        }
        const expected: Record<typeof kind, SectionName> = {
            baseline: 'Baseline',
            security: 'Security',
        }
        if (section !== expected[kind]) {
            const prefix = kind === 'baseline' ? 'the BASELINE' : 'an S-'
            problems.push(`${id}: ${prefix} line belongs in ${expected[kind]}`)
            continue
        }
        const stagingOnly = STAGING_ONLY.test(rest)
        rest = rest.replace(STAGING_ONLY, '')
        const [title, ...steps] = rest.split(' — ')
        const text = steps.join(' — ').trim()
        if (!title.trim() || !text) {
            problems.push(`${id}: needs "<title> — <steps>"`)
            continue
        }
        lines.push({
            id,
            title: title.trim(),
            kind: 'check',
            text,
            source: { type: 'card', ref: 'plan' },
            section: kind,
            stagingOnly,
        })
    }

    for (const name of PLAN_SECTIONS) {
        if (!seenSections.includes(name) && !OPTIONAL_SECTIONS.includes(name)) {
            problems.push(`missing section "${name}"`)
        }
    }
    const order = seenSections.filter(s => (PLAN_SECTIONS as readonly string[]).includes(s))
    const expectedOrder = PLAN_SECTIONS.filter(s => order.includes(s))
    if (order.join('|') !== expectedOrder.join('|')) {
        problems.push(`sections are out of order: expected ${PLAN_SECTIONS.join(', ')}`)
    }
    if (!lines.some(l => l.id === 'BASELINE')) problems.push('Baseline has no [BASELINE] line')
    if (options.prs) problems.push(...completenessProblems(lines, options.prs))

    if (problems.length) throw new PlanLinesError(problems)
    return { card: tag, target: 'release', lines }
}
