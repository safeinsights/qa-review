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
    for (const s of secrets) out = out.split(s).join('[redacted]')
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
    if (entry.result === 'FAIL') return `FAIL (${entry.severity ?? '?'}, ${entry.area ?? '?'})`
    if (entry.result === 'NOT TESTED') return `NOT TESTED (${entry.approvedBy ?? '?'})`
    return entry.result
}

function table(
    lines: InventoryLine[],
    byId: Map<string, ResultEntry>,
    secrets: string[]
): string[] {
    const rows = ['| ID | Line | Result | Evidence |', '|---|---|---|---|']
    for (const l of lines) {
        const e = byId.get(l.id)
        rows.push(
            `| ${l.id} | ${cell(l.title ?? '')} | ${resultCell(e)} | ${cell(redact(e?.evidence ?? '', secrets))} |`
        )
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
    const countLine = RESULT_VALUES.filter(v => counts[v] > 0)
        .map(v => `${v} ${counts[v]}`)
        .concat(missing ? [`NO RESULT ${missing}`] : [])
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
            const prs = [...new Set(lines.map(l => l.pr))]
            for (const pr of prs) {
                out.push(
                    `### #${pr}`,
                    '',
                    ...table(
                        lines.filter(l => l.pr === pr),
                        byId,
                        input.secrets
                    ),
                    ''
                )
            }
        } else {
            out.push(...table(lines, byId, input.secrets), '')
        }
    }
    section('Baseline', l => l.section === 'baseline')
    section('Changes', l => l.section === 'changes')
    section('Security', l => l.section === 'security')
    return out.join('\n')
}
