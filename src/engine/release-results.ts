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
    // The uploaded asset: management-app is public, so S- lines and their results
    // are left out entirely (rows, counts and the Security section).
    publicOnly: boolean
    // The private Confluence page with the screenshots (qar release-confluence).
    pageUrl?: string
}

// Values that must never reach a release asset. Names, not values, decide: every
// password, MFA, private key, token and secret var in the merged settings.
const SECRET_NAME = /_PASSWORD|_MFA_|_PRIVATE_KEY|_TOKEN|_SECRET/

export function secretValues(vars: Vars): string[] {
    return Object.entries(vars)
        .filter(([k, v]) => SECRET_NAME.test(k) && typeof v === 'string' && v.length > 0)
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

function isSecurity(id: string, section?: string): boolean {
    return section === 'security' || /^S-\d+$/.test(id)
}

// The asset. With publicOnly, every S- line and result is dropped before anything is
// counted, so the counts cannot reveal that security lines exist.
export function renderResults(input: RenderInput): string {
    const keep = (id: string, section?: string) => !input.publicOnly || !isSecurity(id, section)
    return render(
        {
            ...input,
            plan: { ...input.plan, lines: input.plan.lines.filter(l => keep(l.id, l.section)) },
            results: input.results.filter(r => keep(r.id)),
        },
        `# Regression results ${input.tag} — ${input.env}`
    )
}

// The local-only companion: the S- lines alone, in the same table. Never uploaded.
export function renderSecurityResults(input: Omit<RenderInput, 'publicOnly'>): string {
    return render(
        {
            ...input,
            plan: {
                ...input.plan,
                lines: input.plan.lines.filter(l => isSecurity(l.id, l.section)),
            },
            results: input.results.filter(r => isSecurity(r.id)),
        },
        `# Security results ${input.tag} — ${input.env}`
    )
}

export function hasSecurityResults(results: ResultEntry[]): boolean {
    return results.some(r => isSecurity(r.id))
}

function render(input: Omit<RenderInput, 'publicOnly'>, title: string): string {
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

    const out: string[] = [title, '', `Run at ${stamp(input.now)}. ${countLine}`, '']
    if (input.pageUrl) {
        out.push(`Full results with screenshots (SafeInsights staff only): ${input.pageUrl}`, '')
    }
    const section = (name: string, filter: (l: InventoryLine) => boolean) => {
        const lines = input.plan.lines.filter(filter)
        if (!lines.length) return
        out.push(`## ${name}`, '')
        if (name === 'Changes') {
            const prs = [...new Set(lines.map(l => l.pr).filter(pr => pr !== undefined))]
            for (const pr of prs) {
                const group = lines.filter(l => l.pr === pr)
                const url = group.find(l => l.prUrl)?.prUrl
                const heading = url ? `### [#${pr}](${url})` : `### #${pr}`
                out.push(heading, '', ...table(group, byId, input.secrets), '')
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
