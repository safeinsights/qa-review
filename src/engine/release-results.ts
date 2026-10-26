import type { Inventory, InventoryLine } from './inventory'
import { RESULT_VALUES, type ResultEntry, type ResultValue } from './results'
import type { Vars } from './settings'

export interface RenderInput {
    tag: string
    env: string
    plan: Inventory
    results: ResultEntry[]
    secrets: string[]
    now: Date
}

// Values that must never reach a release asset. Names, not values, decide: every
// *_PASSWORD* and *_MFA_* var in the merged settings.
export function secretValues(vars: Vars): string[] {
    return Object.entries(vars)
        .filter(([k, v]) => /_PASSWORD|_MFA_/.test(k) && typeof v === 'string' && v.length > 0)
        .map(([, v]) => v as string)
}

function redact(text: string, secrets: string[]): string {
    let out = text
    // Longest first: a secret that contains another would otherwise survive in part.
    const ordered = secrets.filter(s => s.length > 0).sort((a, b) => b.length - a.length)
    for (const s of ordered) out = out.split(s).join('[redacted]')
    return out
}

function cell(text: string): string {
    return text.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')
}

function stamp(d: Date): string {
    const p = (n: number) => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

function resultCell(entry: ResultEntry | undefined): string {
    if (!entry) return 'MISSING'
    if (!RESULT_VALUES.includes(entry.result)) {
        return `MISSING (unknown result "${entry.result}")`
    }
    if (entry.result === 'FAIL') return `FAIL (${entry.severity ?? '?'}, ${entry.area ?? '?'})`
    if (entry.result === 'NOT TESTED') return `NOT TESTED (${entry.approvedBy ?? '?'})`
    return entry.result
}

function rowFor(
    id: string,
    title: string,
    entry: ResultEntry | undefined,
    secrets: string[]
): string {
    return `| ${id} | ${cell(title)} | ${resultCell(entry)} | ${cell(redact(entry?.evidence ?? '', secrets))} |`
}

function table(
    lines: InventoryLine[],
    byId: Map<string, ResultEntry>,
    secrets: string[]
): string[] {
    const rows = ['| ID | Line | Result | Evidence |', '|---|---|---|---|']
    for (const l of lines) {
        const e = byId.get(l.id)
        rows.push(rowFor(l.id, l.title ?? '', e, secrets))
    }
    return rows
}

export function renderResults(input: RenderInput): string {
    const byId = new Map(input.results.map(r => [r.id, r]))
    const counts = Object.fromEntries(RESULT_VALUES.map(v => [v, 0])) as Record<ResultValue, number>
    let missing = 0
    for (const l of input.plan.lines) {
        const e = byId.get(l.id)
        if (e && RESULT_VALUES.includes(e.result)) counts[e.result] += 1
        else missing += 1
    }
    const planned = new Set(input.plan.lines.map(l => l.id))
    const unplanned = input.results.filter(r => !planned.has(r.id))
    const countLine = RESULT_VALUES.filter(v => counts[v] > 0)
        .map(v => `${v} ${counts[v]}`)
        .concat(missing ? [`NO RESULT ${missing}`] : [])
        .concat(unplanned.length ? [`UNPLANNED ${unplanned.length}`] : [])
        .join(' · ')

    const out: string[] = [
        `# Regression results ${input.tag} — ${input.env}`,
        '',
        `Run at ${stamp(input.now)}. ${countLine}`,
        '',
    ]
    const section = (name: string, filter: (l: InventoryLine) => boolean) => {
        const lines = input.plan.lines.filter(filter)
        if (!lines.length) return
        out.push(`## ${name}`, '')
        if (name === 'Changes') {
            const prs = [...new Set(lines.map(l => l.pr).filter(pr => pr !== undefined))]
            for (const pr of prs) {
                const group = lines.filter(l => l.pr === pr)
                out.push(`### #${pr}`, '', ...table(group, byId, input.secrets), '')
            }
            const noPr = lines.filter(l => l.pr === undefined)
            if (noPr.length) out.push('### (no PR)', '', ...table(noPr, byId, input.secrets), '')
        } else {
            out.push(...table(lines, byId, input.secrets), '')
        }
    }
    section('Baseline', l => l.section === 'baseline')
    section('Changes', l => l.section === 'changes')
    section('Security', l => l.section === 'security')
    const known = ['baseline', 'changes', 'security']
    section('Other', l => !known.includes(l.section ?? ''))
    if (unplanned.length) {
        const rows = ['| ID | Line | Result | Evidence |', '|---|---|---|---|']
        for (const r of unplanned) rows.push(rowFor(r.id, '', r, input.secrets))
        out.push('## Unplanned results', '', ...rows, '')
    }
    return out.join('\n')
}
