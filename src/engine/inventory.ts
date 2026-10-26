// The requirement inventory a validation session builds before it tests anything.
//
// The JSON is the source of truth: the chat summary the user approves and the HTML
// page shown in the session browser are both derived from it, so the two can never
// disagree about what is going to be tested. The HTML is a single self-contained
// file (inline CSS and JS, no CDN) because it is opened from .tmp/ over file://,
// where nothing external is guaranteed to load.

// `observed` is for something seen during testing that no source asked for; such a
// line can only be a FAIL (see results.ts), which is what keeps it from being deferred.
export type SourceType = 'card' | 'comment' | 'attachment' | 'figma' | 'observed'

export type LineKind = 'check' | 'absence' | 'context'

export interface LineSource {
    type: SourceType
    ref: string
    url?: string
    page?: string
    frame?: string
    category?: string
}

export interface InventoryLine {
    id: string
    // A short plain-language name ("Submitted by resets at the code stage"). The
    // report names lines by title, so a reader never needs the inventory open.
    title?: string
    kind: LineKind
    text: string
    source: LineSource
    conflictWith?: string
    // Release-plan lines only (plan-lines.ts). `stagingOnly` marks an active probe
    // that must not run on production; results-check enforces it with --env.
    section?: 'baseline' | 'changes' | 'security'
    pr?: number
    stagingOnly?: boolean
}

export interface Inventory {
    card: string
    target: string
    lines: InventoryLine[]
}

export interface InventorySummary {
    lines: number
    checks: number
    absences: number
    context: number
    conflicts: number
    sources: Record<SourceType, number>
}

const SOURCE_TYPES: SourceType[] = ['card', 'comment', 'attachment', 'figma', 'observed']

export function summarize(inventory: Inventory): InventorySummary {
    const sources = Object.fromEntries(SOURCE_TYPES.map(t => [t, 0])) as Record<SourceType, number>
    let checks = 0
    let absences = 0
    let context = 0
    const conflictPairs = new Set<string>()
    for (const line of inventory.lines) {
        sources[line.source.type] += 1
        if (line.kind === 'check') checks += 1
        else if (line.kind === 'absence') absences += 1
        else context += 1
        // Each conflict is recorded on both lines; count the pair once.
        if (line.conflictWith) conflictPairs.add([line.id, line.conflictWith].sort().join('|'))
    }
    return {
        lines: inventory.lines.length,
        checks,
        absences,
        context,
        conflicts: conflictPairs.size,
        sources,
    }
}

function escapeHtml(value: string): string {
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
}

function plural(n: number, word: string): string {
    return `${n} ${word}${n === 1 ? '' : 's'}`
}

// URLs come from Jira and Figma text, so `javascript:` and friends render as text.
function isSafeUrl(url: string): boolean {
    try {
        return ['http:', 'https:'].includes(new URL(url).protocol)
    } catch {
        return false
    }
}

function sourceCell(source: LineSource): string {
    const label = escapeHtml(source.ref)
    const text =
        source.url && isSafeUrl(source.url)
            ? `<a href="${escapeHtml(source.url)}" target="_blank" rel="noopener noreferrer">${label}</a>`
            : label
    const type = escapeHtml(source.type)
    return `<span class="src src-${type}">${type}</span> ${text}`
}

function row(line: InventoryLine): string {
    const conflict = line.conflictWith ? ' data-conflict="true"' : ''
    const category = line.source.category
        ? `<span class="cat">${escapeHtml(line.source.category)}</span>`
        : ''
    const conflictNote = line.conflictWith
        ? `<div class="conflict">conflicts with ${escapeHtml(line.conflictWith)}</div>`
        : ''
    return (
        `<tr data-line="${escapeHtml(line.id)}" data-kind="${escapeHtml(line.kind)}" data-source="${escapeHtml(line.source.type)}"${conflict}>` +
        `<td class="id">${escapeHtml(line.id)}</td>` +
        `<td class="title">${escapeHtml(line.title ?? '')}</td>` +
        `<td class="kind">${escapeHtml(line.kind)}</td>` +
        `<td class="text">${escapeHtml(line.text)}${conflictNote}</td>` +
        `<td class="source">${sourceCell(line.source)}</td>` +
        `<td class="category">${category}</td>` +
        '</tr>'
    )
}

const STYLE = `
body{font:14px/1.4 system-ui,sans-serif;margin:24px;color:#1a1a1a;background:#fff}
h1{font-size:20px;margin:0 0 4px}
.summary{color:#555;margin-bottom:16px}
.controls{display:flex;gap:12px;margin-bottom:12px;flex-wrap:wrap}
.controls input{padding:6px 8px;font:inherit;min-width:260px}
.controls label{display:inline-flex;gap:4px;align-items:center}
table{border-collapse:collapse;width:100%}
th,td{text-align:left;vertical-align:top;padding:6px 8px;border-bottom:1px solid #e5e5e5}
th{background:#f4f4f4;position:sticky;top:0}
td.id{font-family:ui-monospace,monospace;white-space:nowrap}
tr[data-kind=absence] td.kind{color:#b00020;font-weight:600}
tr[data-kind=context]{color:#777}
tr[data-conflict=true] td.text{background:#fff4d6}
.conflict{font-size:12px;color:#8a5a00;margin-top:2px}
.src{font-size:11px;padding:1px 6px;border-radius:8px;background:#e8eef7;margin-right:4px}
.src-figma{background:#efe3fb}.src-comment{background:#e3f6e8}.src-attachment{background:#fbeede}.src-observed{background:#fde0e0}
.cat{font-size:12px;padding:1px 6px;border-radius:4px;background:#f0f0f0}
tr.hidden{display:none}
`

const SCRIPT = `
const q=document.getElementById('q');const boxes=[...document.querySelectorAll('input[data-filter]')];
function apply(){const needle=q.value.toLowerCase();const on=Object.fromEntries(boxes.map(b=>[b.dataset.filter+':'+b.value,b.checked]));
for(const tr of document.querySelectorAll('tbody tr')){const kindOn=on['kind:'+tr.dataset.kind];const srcOn=on['source:'+tr.dataset.source];
const hit=!needle||tr.textContent.toLowerCase().includes(needle);tr.classList.toggle('hidden',!(kindOn&&srcOn&&hit));}}
q.addEventListener('input',apply);boxes.forEach(b=>b.addEventListener('change',apply));
`

function filterBox(group: string, value: string, label: string): string {
    return `<label><input type="checkbox" data-filter="${group}" value="${value}" checked>${label}</label>`
}

export function renderInventoryHtml(inventory: Inventory): string {
    const s = summarize(inventory)
    const summary =
        `${plural(s.lines, 'requirement')} · ${plural(s.checks, 'check')} · ` +
        `${plural(s.absences, 'absence check')} · ${plural(s.context, 'context line')} · ` +
        `${plural(s.conflicts, 'conflict')} — sources: card ${s.sources.card}, ` +
        `comments ${s.sources.comment}, attachments ${s.sources.attachment}, Figma ${s.sources.figma}, ` +
        `observed ${s.sources.observed}`
    const filters = [
        filterBox('kind', 'check', 'checks'),
        filterBox('kind', 'absence', 'absence checks'),
        filterBox('kind', 'context', 'context'),
        ...SOURCE_TYPES.map(t => filterBox('source', t, t)),
    ].join(' ')
    const rows = inventory.lines.map(row).join('\n')
    return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(inventory.card)} inventory</title>
<style>${STYLE}</style></head><body>
<h1>${escapeHtml(inventory.card)} — requirement inventory (${escapeHtml(inventory.target)})</h1>
<div class="summary">${summary}</div>
<div class="controls"><input id="q" type="search" placeholder="Search requirements…"> ${filters}</div>
<table><thead><tr><th>Id</th><th>Title</th><th>Kind</th><th>Requirement</th><th>Source</th><th>Category</th></tr></thead>
<tbody>
${rows}
</tbody></table>
<script>${SCRIPT}</script>
</body></html>
`
}
