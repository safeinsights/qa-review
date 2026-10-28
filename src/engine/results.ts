import type { Inventory, InventoryLine } from './inventory'

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

// A pair the result rules cannot judge. An observed line must FAIL while a non-card
// side of a pair must be CONFLICT, so no result could ever satisfy both.
function conflictProblems(line: InventoryLine, lines: Map<string, InventoryLine>): string[] {
    const other = line.conflictWith
    if (!other) return []
    if (line.source.type === 'observed') {
        return [`${line.id}: an observed line cannot be in a conflict (it can only be a FAIL)`]
    }
    if (other === line.id) return [`${line.id}: conflictWith points at itself`]
    const pair = lines.get(other)
    if (!pair) return [`${line.id}: conflictWith "${other}" is not in the inventory`]
    if (pair.conflictWith !== line.id) {
        return [`${line.id}: conflictWith "${other}" does not point back at ${line.id}`]
    }
    return []
}

function isBlank(value: unknown): boolean {
    return typeof value !== 'string' || value.trim() === ''
}

// The inventory-side rules: ids, titles, results present, observed lines, conflicts.
function inventoryProblems(
    inventory: Inventory,
    lines: Map<string, InventoryLine>,
    seen: Set<string>
): string[] {
    const problems: string[] = []
    // `lines` keeps the last duplicate, which would let one result cover two lines.
    const ids = new Set<string>()
    for (const line of inventory.lines) {
        if (ids.has(line.id)) problems.push(`${line.id}: duplicate inventory id`)
        ids.add(line.id)
    }
    for (const line of inventory.lines) {
        if (isBlank(line.title)) problems.push(`${line.id}: no title`)
        // Context lines need no result, so this would be a finding that never has to FAIL.
        if (line.source.type === 'observed' && line.kind === 'context') {
            problems.push(`${line.id}: an observed line cannot be context (it can only be a FAIL)`)
        }
        if (line.kind !== 'context' && !seen.has(line.id)) problems.push(`${line.id}: no result`)
        problems.push(...conflictProblems(line, lines))
    }
    return problems
}

export interface CheckOptions {
    env?: string
}

export function checkResults(
    inventory: Inventory,
    results: ResultEntry[],
    options: CheckOptions = {}
): ResultsReport {
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
        if (
            options.env === 'production' &&
            line.stagingOnly &&
            (entry.result === 'PASS' || entry.result === 'FAIL')
        ) {
            problems.push(`${entry.id}: a (staging only) line cannot be PASS or FAIL on production`)
        }
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
        // An observed line in a pair is reported once, by the inventory pass below;
        // the pair rules would only add a second, contradictory demand.
        const paired = Boolean(line.conflictWith) && line.source.type !== 'observed'
        // The card is the spec: its side of a pair is judged against the app, and the
        // other side records the discrepancy for the "Unclear requirements" list.
        if (paired && line.source.type === 'card' && !['PASS', 'FAIL'].includes(entry.result)) {
            problems.push(
                `${entry.id}: the card side of a conflict is checked against the app: PASS or FAIL`
            )
        }
        if (paired && line.source.type !== 'card' && entry.result !== 'CONFLICT') {
            problems.push(
                `${entry.id}: the ${line.source.type === 'figma' ? 'Figma' : line.source.type} side of a conflict must be CONFLICT`
            )
        }
    }

    problems.push(...inventoryProblems(inventory, lines, seen))

    return { ok: problems.length === 0, counts, problems }
}
