import type { Inventory } from './inventory'

// The audit gate between testing and posting. A validation used to be free to file
// an unverified finding under "also observed"; now every check line needs exactly
// one evidenced result, and anything seen outside the inventory can only be a FAIL.
// Rules live here, not in the skill prose, so a gap is named by code.

export const RESULT_VALUES = ['PASS', 'FAIL', 'CONFLICT', 'UNCLEAR', 'NOT TESTED'] as const
export type ResultValue = (typeof RESULT_VALUES)[number]

export const SEVERITIES = ['blocker', 'major', 'minor'] as const
export type Severity = (typeof SEVERITIES)[number]

export interface ResultEntry {
    id: string
    result: ResultValue
    evidence?: string
    severity?: Severity
    area?: string
    approvedBy?: string
    // The PM question, present only on the few lines QA cannot decide.
    decision?: string
}

export interface ResultsReport {
    ok: boolean
    counts: Record<ResultValue, number>
    problems: string[]
}

function isBlank(value: unknown): boolean {
    return typeof value !== 'string' || value.trim() === ''
}

export function checkResults(inventory: Inventory, results: ResultEntry[]): ResultsReport {
    const problems: string[] = []
    const counts = Object.fromEntries(RESULT_VALUES.map(v => [v, 0])) as Record<ResultValue, number>
    const lines = new Map(inventory.lines.map(line => [line.id, line]))
    const seen = new Set<string>()

    for (const entry of results) {
        const line = lines.get(entry.id)
        if (!line) {
            problems.push(`${entry.id}: not in the inventory`)
            continue
        }
        if (seen.has(entry.id)) {
            problems.push(`${entry.id}: more than one result`)
            continue
        }
        seen.add(entry.id)
        if (!RESULT_VALUES.includes(entry.result)) {
            problems.push(`${entry.id}: unknown result "${entry.result}"`)
            continue
        }
        counts[entry.result] += 1
        if (isBlank(entry.evidence)) problems.push(`${entry.id}: no evidence`)
        if (entry.result === 'FAIL') {
            if (!SEVERITIES.includes(entry.severity as Severity)) {
                problems.push(`${entry.id}: FAIL needs a severity (${SEVERITIES.join(', ')})`)
            }
            if (isBlank(entry.area)) problems.push(`${entry.id}: FAIL needs an area`)
        }
        if (entry.result === 'NOT TESTED' && isBlank(entry.approvedBy)) {
            problems.push(`${entry.id}: NOT TESTED needs approvedBy`)
        }
        if (line.source.type === 'observed' && entry.result !== 'FAIL') {
            problems.push(`${entry.id}: an observed line can only be a FAIL`)
        }
        if (entry.result === 'CONFLICT' && !line.conflictWith) {
            problems.push(`${entry.id}: CONFLICT but the line has no conflictWith`)
        }
        // The card is the spec: its side of a pair is judged against the app, and the
        // other side records the discrepancy for the "Unclear requirements" list.
        if (
            line.conflictWith &&
            line.source.type === 'card' &&
            !['PASS', 'FAIL'].includes(entry.result)
        ) {
            problems.push(
                `${entry.id}: the card side of a conflict is checked against the app: PASS or FAIL`
            )
        }
        if (line.conflictWith && line.source.type !== 'card' && entry.result !== 'CONFLICT') {
            problems.push(
                `${entry.id}: the ${line.source.type === 'figma' ? 'Figma' : line.source.type} side of a conflict must be CONFLICT`
            )
        }
    }

    for (const line of inventory.lines) {
        if (isBlank(line.title)) problems.push(`${line.id}: no title`)
        if (line.kind !== 'context' && !seen.has(line.id)) problems.push(`${line.id}: no result`)
    }

    return { ok: problems.length === 0, counts, problems }
}
