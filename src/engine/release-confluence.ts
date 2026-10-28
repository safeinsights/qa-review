import type { Inventory, InventoryLine } from './inventory'
import { STOPPED_EVIDENCE } from './release-run-log'
import { RESULT_VALUES, type ResultEntry, type ResultValue } from './results'

// The private record of one release run: a Confluence page with every line's result
// and its screenshot, the security results included (collapsed). The public release
// asset stays text only, with a link here: management-app is public, and images
// cannot be redacted the way text is.

export interface RunPageInput {
    tag: string
    env: string
    plan: Inventory
    results: ResultEntry[]
    secrets: string[]
    now: Date
    releaseUrl?: string
    prs?: { number: number; title: string; jiraKeys?: string[] }[]
    // The Jira boards (JIRA_BOARDS): a FAIL card is linked only on one of these.
    boards?: string[]
    // The plan files attached to the page, by attachment name, with a label each.
    planFiles?: { name: string; label: string }[]
    // Whether a screenshot named in evidence exists on this machine.
    shotExists: (file: string) => boolean
}

export interface RunPage {
    title: string
    storage: string
    // File names under .tmp/release/<tag>/shots/ that the page shows; each is
    // attached to the page.
    images: string[]
    // The Jira cards of the PRs with a FAIL: they get a link to the page.
    failCards: string[]
}

function esc(text: string): string {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
}

function redact(text: string, secrets: string[]): string {
    let out = text
    const ordered = secrets.filter(s => s.length > 0).sort((a, b) => b.length - a.length)
    for (const s of ordered) out = out.split(s).join('[redacted]')
    return out
}

function stamp(d: Date): string {
    const p = (n: number) => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

const COLOUR: Record<ResultValue, string> = {
    PASS: 'Green',
    FAIL: 'Red',
    'NOT TESTED': 'Grey',
    UNCLEAR: 'Yellow',
    CONFLICT: 'Purple',
}

function lozenge(result: ResultValue | undefined): string {
    const title = result ?? 'NO RESULT'
    const colour = result ? COLOUR[result] : 'Grey'
    return `<ac:structured-macro ac:name="status"><ac:parameter ac:name="colour">${colour}</ac:parameter><ac:parameter ac:name="title">${esc(title)}</ac:parameter></ac:structured-macro>`
}

function expand(title: string, body: string): string {
    return `<ac:structured-macro ac:name="expand"><ac:parameter ac:name="title">${esc(title)}</ac:parameter><ac:rich-text-body>${body}</ac:rich-text-body></ac:structured-macro>`
}

// Screenshot paths in evidence: ".tmp/release/<tag>/shots/<name>.png" or "shots/<name>.png".
const SHOT = /(?:\.tmp\/release\/[^/\s,]+\/)?shots\/([A-Za-z0-9._-]+\.(?:png|jpe?g|webp))/g

export function shotsIn(evidence: string): string[] {
    return [...new Set([...evidence.matchAll(SHOT)].map(m => m[1]))]
}

function isSecurity(line: InventoryLine): boolean {
    return line.section === 'security' || /^S-\d+$/.test(line.id)
}

// The cards a PR belongs to: the keys in its title, or its first key when the title
// names none. Keys the description only mentions ("related to OTTER-99") are not
// the PR's own card. With `boards`, a key on another board is never taken.
export function prCards(pr: { title: string; jiraKeys?: string[] }, boards?: string[]): string[] {
    const onBoard = (key: string) => !boards || boards.includes(key.split('-')[0])
    const inTitle = [...pr.title.matchAll(/\b([A-Z][A-Z0-9]+-\d+)\b/g)].map(m => m[1])
    const own = inTitle.filter(onBoard)
    if (own.length) return [...new Set(own)]
    const first = pr.jiraKeys?.find(onBoard)
    return first ? [first] : []
}

// Screenshot paths are for the runner's machine; the page shows the images.
const SHOT_PATH = String.raw`(?:\.tmp\/release\/[^/\s,]+\/)?shots\/[A-Za-z0-9._-]+\.(?:png|jpe?g|webp)`
// "Screenshot(s) a.png, b.png and c.png" — a separator counts only between two paths.
const SHOT_MENTION = new RegExp(
    String.raw`\s*Screenshots?:?\s+${SHOT_PATH}(?:(?:,\s*|\s+and\s+)${SHOT_PATH})*\.?`,
    'gi'
)

export function cleanEvidence(text: string): string {
    return text
        .replace(SHOT_MENTION, '')
        .replace(SHOT, '')
        .replace(/\s{2,}/g, ' ')
        .trim()
}

// The plan's run group of a Changes line: "3 · Researcher · no study".
function groupLabel(line: InventoryLine & { role?: string; needs?: string }): string {
    const g = line.id.split('.')[0]
    const role = line.role ? line.role[0].toUpperCase() + line.role.slice(1) : ''
    const setup =
        !line.needs || line.needs === 'none'
            ? 'no study'
            : `study: ${line.needs.replace(/-/g, ' ')}`
    return [g, role, setup].filter(Boolean).join(' · ')
}

function countsOf(entries: (ResultEntry | undefined)[]): string {
    return RESULT_VALUES.map(v => [v, entries.filter(e => e?.result === v).length] as const)
        .filter(([, n]) => n)
        .map(([v, n]) => `${n} ${v}`)
        .join(', ')
}

// Confluence's own table, with set column widths. Equal columns put a paragraph of
// evidence in a quarter of the page, one word per line. The widths add up to
// Confluence's normal content width (760px), so it scales them to the reader's
// window; a wider table scrolls sideways and hides the evidence.
const CONTENT_WIDTH = 760

function table(head: string[], widths: number[], rows: string[]): string {
    const cols = widths.map(w => `<col style="width: ${w}.0px;" />`).join('')
    const ths = head.map(h => `<th><p><strong>${esc(h)}</strong></p></th>`).join('')
    return `<table data-layout="default"><colgroup>${cols}</colgroup><tbody><tr>${ths}</tr>${rows.join('')}</tbody></table>`
}

export function buildRunPage(input: RunPageInput): RunPage {
    const byId = new Map(input.results.map(r => [r.id, r]))
    const images = new Set<string>()
    const lines = input.plan.lines as (InventoryLine & { role?: string; needs?: string })[]

    const reached = (l: InventoryLine) => {
        const e = byId.get(l.id)
        return Boolean(e) && e?.evidence !== STOPPED_EVIDENCE
    }
    const shotsOf = (e: ResultEntry | undefined): string[] => {
        const shots = shotsIn(e?.evidence ?? '').filter(name => input.shotExists(name))
        for (const s of shots) images.add(s)
        return shots
    }
    const thumbs = (names: string[], width: number) =>
        names.length
            ? `<p>${names.map(n => `<ac:image ac:thumbnail="true" ac:width="${width}"><ri:attachment ri:filename="${esc(n)}" /></ac:image>`).join(' ')}</p>`
            : ''
    const evidence = (e: ResultEntry | undefined) =>
        esc(cleanEvidence(redact(e?.evidence ?? '', input.secrets)))
    const detail = (e: ResultEntry | undefined): string => {
        if (e?.result === 'FAIL') return ` ${esc(`${e.severity ?? '?'}, ${e.area ?? '?'}`)}`
        if (e?.result === 'NOT TESTED') return ` ${esc(`approved by ${e.approvedBy ?? '?'}`)}`
        return ''
    }
    const prLink = (l: InventoryLine) =>
        l.pr === undefined ? '' : l.prUrl ? `<a href="${esc(l.prUrl)}">#${l.pr}</a>` : `#${l.pr}`

    // A line worth reading on its own: a failure, a known issue that looks fixed.
    const block = (l: InventoryLine & { role?: string; needs?: string }) => {
        const e = byId.get(l.id)
        const where = [
            prLink(l) && `PR ${prLink(l)}`,
            l.section === 'changes' ? esc(groupLabel(l)) : '',
        ]
            .filter(Boolean)
            .join(' · ')
        return [
            `<h3>${esc(l.id)} · ${esc(l.title ?? '')}</h3>`,
            `<p>${lozenge(e?.result)}${detail(e)}${where ? ` · ${where}` : ''}</p>`,
            `<p>${evidence(e)}</p>`,
            thumbs(shotsOf(e), 340),
        ].join('')
    }
    const row = (l: InventoryLine) => {
        const e = byId.get(l.id)
        return `<tr><td><p>${esc(l.id)}</p></td><td><p>${esc(l.title ?? '')}</p></td><td><p>${prLink(l)}</p></td><td><p>${lozenge(e?.result)}${detail(e)}</p></td><td><p>${evidence(e)}</p>${thumbs(shotsOf(e), 160)}</td></tr>`
    }
    const resultsTable = (ls: InventoryLine[]) =>
        table(['ID', 'Line', 'PR', 'Result', 'Evidence'], [50, 170, 70, 100, 370], ls.map(row))

    const counts = Object.fromEntries(RESULT_VALUES.map(v => [v, 0])) as Record<ResultValue, number>
    for (const l of lines) {
        const r = byId.get(l.id)?.result
        if (r && RESULT_VALUES.includes(r)) counts[r] += 1
    }
    const notReached = lines.filter(l => !reached(l))

    const out: string[] = []
    const release = input.releaseUrl
        ? `<a href="${esc(input.releaseUrl)}">${esc(input.tag)}</a>`
        : esc(input.tag)
    out.push(
        `<p>Release ${release} on <strong>${esc(input.env)}</strong>, run at ${esc(stamp(input.now))}.</p>`,
        `<p>${RESULT_VALUES.filter(v => counts[v])
            .map(v => `${lozenge(v)} ${counts[v]}`)
            .join(
                ' &nbsp; '
            )}${notReached.length ? ` &nbsp; (${notReached.length} not reached: the run was stopped before them)` : ''}</p>`
    )

    if (input.planFiles?.length) {
        const links = input.planFiles.map(
            f =>
                `<li><ac:link><ri:attachment ri:filename="${esc(f.name)}" /><ac:plain-text-link-body><![CDATA[${f.name}]]></ac:plain-text-link-body></ac:link> — ${esc(f.label)}</li>`
        )
        out.push('<h2>Testing plan</h2>', `<ul>${links.join('')}</ul>`)
    }

    const nonSecurity = lines.filter(l => !isSecurity(l))
    const fails = nonSecurity.filter(l => byId.get(l.id)?.result === 'FAIL')
    if (fails.length) out.push(`<h2>Failures (${fails.length})</h2>`, ...fails.map(block))
    const fixed = nonSecurity.filter(l =>
        /known issue \S+ looks fixed/i.test(byId.get(l.id)?.evidence ?? '')
    )
    if (fixed.length) {
        out.push(`<h2>Known issues that look fixed (${fixed.length})</h2>`, ...fixed.map(block))
    }

    const baseline = lines.filter(l => l.section === 'baseline')
    if (baseline.length) out.push('<h2>Baseline</h2>', ...baseline.map(block))

    // Every tested line, by the plan's run group, collapsed: the failures are above.
    const changes = lines.filter(l => l.section === 'changes' && reached(l))
    if (changes.length) {
        out.push('<h2>Results by run group</h2>')
        const groups = [...new Set(changes.map(groupLabel))]
        for (const g of groups) {
            const ls = changes.filter(l => groupLabel(l) === g)
            out.push(expand(`${g} — ${countsOf(ls.map(l => byId.get(l.id)))}`, resultsTable(ls)))
        }
    }

    const other = lines.filter(
        l => !isSecurity(l) && !['baseline', 'changes'].includes(l.section ?? '') && reached(l)
    )
    if (other.length) out.push('<h2>Other</h2>', resultsTable(other))

    const security = lines.filter(isSecurity)
    if (security.length) {
        const tested = security.filter(reached)
        out.push('<h2>Security</h2>')
        if (tested.length) {
            out.push(
                expand(
                    `Security results — ${countsOf(tested.map(l => byId.get(l.id)))}`,
                    resultsTable(tested)
                )
            )
        } else out.push(`<p>None of the ${security.length} security lines was reached.</p>`)
    }

    if (notReached.length) {
        out.push(
            '<h2>Not reached</h2>',
            expand(
                `${notReached.length} lines the run did not reach`,
                table(
                    ['ID', 'Line'],
                    [70, CONTENT_WIDTH - 70],
                    notReached.map(
                        l =>
                            `<tr><td><p>${esc(l.id)}</p></td><td><p>${esc(l.title ?? '')}</p></td></tr>`
                    )
                )
            )
        )
    }

    const failCards = new Set<string>()
    for (const l of fails) {
        const pr = input.prs?.find(p => p.number === l.pr)
        if (pr) for (const key of prCards(pr, input.boards)) failCards.add(key)
    }

    return {
        title: `${input.tag} ${input.env} — ${stamp(input.now)} run`,
        storage: out.join(''),
        images: [...images],
        failCards: [...failCards],
    }
}
