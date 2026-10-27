// The run order of a regression plan's Changes section. The plan reads in the order a
// tester runs it, so it is sorted to sign in as few times as possible and to create as
// few studies as possible: one study is moved through its stages, and each check runs
// while the study is at the stage it needs.

export const ROLES = ['admin', 'researcher', 'reviewer'] as const
export type Role = (typeof ROLES)[number]

interface Action {
    role: Role
    text: string
}

interface Stage {
    key: string
    // Reads after "study with" in a group heading.
    label: string
    // How to reach this stage from the stage before it in STAGES.
    reach: Action[]
    // How to reach it when the stage before it is skipped (only `code-approved`, when no
    // check needs the code sent back).
    reachSkipping?: Action[]
    optional?: boolean
}

// The study lifecycle in study-happy-path order.
export const STAGES: readonly Stage[] = [
    {
        key: 'proposal-draft',
        label: 'a draft proposal',
        reach: [
            {
                role: 'researcher',
                text: 'start a new study proposal with a natural title and description, and leave it as a draft',
            },
        ],
    },
    {
        key: 'proposal-submitted',
        label: 'a submitted proposal',
        reach: [{ role: 'researcher', text: 'submit the proposal' }],
    },
    {
        key: 'proposal-approved',
        label: 'an approved proposal',
        reach: [{ role: 'reviewer', text: 'approve the proposal' }],
    },
    {
        key: 'code-submitted',
        label: 'submitted code',
        reach: [{ role: 'researcher', text: 'upload the study code and submit it' }],
    },
    {
        key: 'code-changes-requested',
        label: 'code changes requested',
        reach: [{ role: 'reviewer', text: 'request changes to the code' }],
        optional: true,
    },
    {
        key: 'code-approved',
        label: 'approved code',
        reach: [
            { role: 'researcher', text: 'resubmit the code' },
            { role: 'reviewer', text: 'approve the code' },
        ],
        reachSkipping: [{ role: 'reviewer', text: 'approve the code' }],
    },
    {
        key: 'results-ready',
        label: 'results to review',
        reach: [{ role: 'reviewer', text: 'wait for the run to finish and the results to show' }],
    },
    {
        key: 'results-approved',
        label: 'approved results',
        reach: [{ role: 'reviewer', text: 'approve the results' }],
    },
]

export type Needs = 'none' | string

export interface ChangeLine {
    // "<group>.<n>"; absent on a line a person added, which plan-order numbers.
    number?: string
    title: string
    steps: string
    pr?: number
    // The link the line was written with; plan-order writes every link from the repo.
    prUrl?: string
    stagingOnly: boolean
    // The check leaves the study unable to move on (a rejection, a delete), so it runs
    // on a study of its own or at the very end of the walk.
    endsStudy: boolean
    role: Role
    needs: Needs
}

export interface RunGroup {
    kind: 'group'
    role: Role
    needs: Needs
    newStudy: boolean
    lines: ChangeLine[]
}

export interface RunNote {
    kind: 'note'
    text: string
}

export type RunItem = RunGroup | RunNote

const NO_STUDY = 'no study'
const SEPARATOR = /\s+[·|-]\s+/

function stageIndex(needs: Needs): number {
    return STAGES.findIndex(s => s.key === needs)
}

function capitalize(s: string): string {
    return s.charAt(0).toUpperCase() + s.slice(1)
}

export function needsLabel(needs: Needs, newStudy = false): string {
    if (needs === 'none') return NO_STUDY
    const stage = STAGES[stageIndex(needs)]
    return `${newStudy ? 'new ' : ''}study with ${stage.label}`
}

export function groupHeading(n: number, group: RunGroup): string {
    return `### ${n}. ${capitalize(group.role)} · ${needsLabel(group.needs, group.newStudy)}`
}

export interface ParsedHeading {
    number: number
    role: Role
    needs: Needs
    newStudy: boolean
}

export const HEADING_FORM = '### <n>. <Role> · <no study | study with …>'

// `### 4. Reviewer · study with a submitted proposal`. Returns an error string for a
// `###` heading that is not a run group, so a typo in a role or a stage is named
// instead of silently giving its lines the wrong setup.
export function parseGroupHeading(raw: string): ParsedHeading | string | null {
    const m = /^###\s+(.*?)\s*$/.exec(raw)
    if (!m) return null
    const head = /^(\d+)\.\s+(.+)$/.exec(m[1])
    if (!head) return `"${raw.trim()}": a run group heading is "${HEADING_FORM}"`
    const parts = head[2].split(SEPARATOR)
    if (parts.length !== 2) return `"${raw.trim()}": a run group heading is "${HEADING_FORM}"`
    const role = parts[0].trim().toLowerCase() as Role
    if (!ROLES.includes(role)) {
        return `"${raw.trim()}": the role is one of ${ROLES.map(capitalize).join(', ')}`
    }
    const setup = parts[1].trim().toLowerCase()
    if (setup === NO_STUDY) return { number: Number(head[1]), role, needs: 'none', newStudy: false }
    const study = /^(new\s+)?study with\s+(.+)$/.exec(setup)
    const stage = study && STAGES.find(s => s.label === study[2].trim())
    if (!study || !stage) {
        const labels = [NO_STUDY, ...STAGES.map(s => `study with ${s.label}`)]
        return `"${raw.trim()}": the setup is one of: ${labels.join('; ')}`
    }
    return { number: Number(head[1]), role, needs: stage.key, newStudy: Boolean(study[1]) }
}

const LINE = /^- (?:(\d+\.\d+)\s+)?(.+)$/
const PR_LINK = /\s*\(\[PR #(\d+)\]\(([^()\s]+)\)\)\s*$/
const PR_PLAIN = /\s*\(PR #(\d+)\)\s*$/
const STAGING_ONLY = /\s*\(staging only\)\s*$/i
const ENDS_STUDY = /\s*\(ends the study\)\s*$/i

export const LINE_FORM = '- <n>.<n> <title> — <steps> ([PR #<n>](<url>))'

// A Changes test line, without its group's role and setup. The trailing markers may
// come in any order, since a person editing the plan will not keep one.
export function parseChangeLine(raw: string): Omit<ChangeLine, 'role' | 'needs'> | string | null {
    const m = LINE.exec(raw)
    if (!m) return null
    // An old "[R-<pr>-<n>]" id would otherwise read as part of the title.
    if (!m[1] && /^\[[^\]]*\]/.test(m[2])) return `${raw.trim()}: a test line is "${LINE_FORM}"`
    let rest = m[2]
    let pr: number | undefined
    let url: string | undefined
    let stagingOnly = false
    let endsStudy = false
    for (;;) {
        const link = PR_LINK.exec(rest) ?? PR_PLAIN.exec(rest)
        if (link) {
            pr = Number(link[1])
            url = link[2]
            rest = rest.slice(0, link.index)
        } else if (STAGING_ONLY.test(rest)) {
            stagingOnly = true
            rest = rest.replace(STAGING_ONLY, '')
        } else if (ENDS_STUDY.test(rest)) {
            endsStudy = true
            rest = rest.replace(ENDS_STUDY, '')
        } else break
    }
    const [title, ...steps] = rest.split(' — ')
    const text = steps.join(' — ').trim()
    if (!title.trim() || !text) return `${raw.trim()}: a test line is "${LINE_FORM}"`
    return {
        number: m[1],
        title: title.trim(),
        steps: text,
        pr,
        prUrl: url,
        stagingOnly,
        endsStudy,
    }
}

export function prUrl(repo: string, pr: number): string {
    return `https://github.com/${repo}/pull/${pr}`
}

export function renderLine(id: string, line: ChangeLine, repo: string): string {
    const marks = [
        line.endsStudy ? ' (ends the study)' : '',
        line.stagingOnly ? ' (staging only)' : '',
        line.pr === undefined ? '' : ` ([PR #${line.pr}](${prUrl(repo, line.pr)}))`,
    ].join('')
    return `- ${id} ${line.title} — ${line.steps}${marks}`
}

// Admin first, as no study step needs it; the reviewer before the researcher, who
// starts the study.
const FIXED_ROLE_ORDER: readonly Role[] = ['admin', 'reviewer', 'researcher']

// One switch per role at a stage: start as whoever is signed in, end as whoever moves
// the study on, everyone else between.
function roleOrder(present: Role[], start: Role | null, end: Role | null): Role[] {
    const middle = FIXED_ROLE_ORDER.filter(r => present.includes(r) && r !== start && r !== end)
    const first = start && present.includes(start) ? [start] : []
    const last = end && end !== start && present.includes(end) ? [end] : []
    return [...first, ...middle, ...last]
}

function groupsAt(
    lines: ChangeLine[],
    needs: Needs,
    newStudy: boolean,
    start: Role | null,
    end: Role | null
): RunGroup[] {
    const roles = [...new Set(lines.map(l => l.role))]
    return roleOrder(roles, start, end).map(role => ({
        kind: 'group',
        role,
        needs,
        newStudy,
        lines: lines.filter(l => l.role === role),
    }))
}

function describeActions(actions: Action[]): string {
    const parts: string[] = []
    let i = 0
    while (i < actions.length) {
        const role = actions[i].role
        const texts: string[] = []
        while (i < actions.length && actions[i].role === role) texts.push(actions[i++].text)
        parts.push(`as ${role}, ${texts.join(', then ')}`)
    }
    return `${parts.join('; then ')}.`
}

// The stages a walk passes through to reach `target`. The optional stage is entered
// only when a check needs it.
function path(target: number, needed: Set<string>): Stage[] {
    return STAGES.slice(0, target + 1).filter(s => !s.optional || needed.has(s.key))
}

function reachActions(stage: Stage, previous: Stage | undefined): Action[] {
    const before = STAGES[STAGES.indexOf(stage) - 1]
    if (stage.reachSkipping && before?.optional && previous !== before) return stage.reachSkipping
    return stage.reach
}

// One study moved through every stage up to the last one a check needs. `finisher`
// ends the study, so it is the walk's last check.
function walk(lines: ChangeLine[], finisher: ChangeLine | undefined, newStudy: boolean): RunItem[] {
    const all = finisher ? [...lines, finisher] : lines
    const target = Math.max(...all.map(l => stageIndex(l.needs)))
    const stages = path(target, new Set(all.map(l => l.needs)))
    const items: RunItem[] = []
    let pending: Action[] = []
    let previous: Stage | undefined
    stages.forEach((stage, i) => {
        pending.push(...reachActions(stage, previous))
        previous = stage
        const here = lines.filter(l => l.needs === stage.key)
        const finishing = finisher && finisher.needs === stage.key ? finisher : undefined
        if (!here.length && !finishing) return
        const lead = newStudy && !items.length ? 'Next, with a new study: ' : 'Next: '
        items.push({ kind: 'note', text: `${lead}${describeActions(pending)}` })
        const start = pending[pending.length - 1].role
        pending = []
        const next = stages[i + 1]
        const end = finishing ? finishing.role : next ? reachActions(next, stage)[0].role : null
        const groups = groupsAt(here, stage.key, newStudy, start, end)
        if (finishing) {
            const last = groups[groups.length - 1]
            if (last && last.role === finishing.role) last.lines.push(finishing)
            else
                groups.push({
                    kind: 'group',
                    role: finishing.role,
                    needs: stage.key,
                    newStudy,
                    lines: [finishing],
                })
        }
        items.push(...groups)
    })
    return items
}

export const CLEANUP_NOTE =
    'Last: as admin, delete every study and user this run created, with the QA cleanup API (`qar cleanup`).'

export function orderChanges(lines: ChangeLine[]): RunItem[] {
    const none = lines.filter(l => l.needs === 'none')
    const study = lines.filter(l => l.needs !== 'none' && !l.endsStudy)
    const ending = lines
        .filter(l => l.needs !== 'none' && l.endsStudy)
        .sort((a, b) => stageIndex(a.needs) - stageIndex(b.needs))
    const mainTarget = Math.max(-1, ...study.map(l => stageIndex(l.needs)))
    const at = ending.findIndex(l => stageIndex(l.needs) >= mainTarget)
    const finisher = at >= 0 ? ending.splice(at, 1)[0] : undefined
    const anyStudy = study.length > 0 || finisher !== undefined
    const items: RunItem[] = groupsAt(none, 'none', false, null, anyStudy ? 'researcher' : null)
    if (anyStudy) items.push(...walk(study, finisher, false))
    for (const line of ending) items.push(...walk([], line, true))
    if (anyStudy) items.push({ kind: 'note', text: CLEANUP_NOTE })
    return items
}

// Numbers the groups and their lines in run order and writes the Changes body.
export function renderChanges(items: RunItem[], repo: string): string {
    const out: string[] = []
    let n = 0
    for (const item of items) {
        if (item.kind === 'note') {
            out.push(`> ${item.text}`, '')
            continue
        }
        n += 1
        out.push(groupHeading(n, item))
        item.lines.forEach((line, i) => {
            out.push(renderLine(`${n}.${i + 1}`, line, repo))
        })
        out.push('')
    }
    return out.join('\n')
}

const GENERATED_NOTE = /^>\s*(Next|Last)\b/

export class PlanOrderError extends Error {
    constructor(public readonly problems: string[]) {
        super(`plan-order found ${problems.length} problem(s):\n${problems.join('\n')}`)
    }
}

// Reads the Changes body leniently (lines may lack numbers, groups may repeat or be out
// of order) but drops nothing: any other content is a problem, because a rewrite that
// deletes a person's notes is worse than a refusal.
export function readChanges(body: string[]): ChangeLine[] {
    const problems: string[] = []
    const lines: ChangeLine[] = []
    let group: ParsedHeading | null = null
    for (const raw of body) {
        if (!raw.trim() || GENERATED_NOTE.test(raw)) continue
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
        const line = parseChangeLine(raw)
        if (line === null) {
            problems.push(
                `"${raw.trim()}": only run groups, test lines and Next notes go in Changes`
            )
            continue
        }
        if (typeof line === 'string') {
            problems.push(line)
            continue
        }
        if (!group) {
            problems.push(`${line.title}: is not under a run group heading ("${HEADING_FORM}")`)
            continue
        }
        if (line.endsStudy && group.needs === 'none') {
            problems.push(`${line.title}: "(ends the study)" needs a group with a study`)
            continue
        }
        lines.push({ ...line, role: group.role, needs: group.needs })
    }
    if (problems.length) throw new PlanOrderError(problems)
    return lines
}

const SECTION_HEADING = /^## (.+?)\s*$/

// Rewrites the Changes section in run order and leaves every other section as it was.
export function reorderPlan(markdown: string, repo: string): string {
    const eol = markdown.includes('\r\n') ? '\r\n' : '\n'
    const rows = markdown.split(/\r?\n/)
    const start = rows.findIndex(r => SECTION_HEADING.exec(r)?.[1] === 'Changes')
    if (start < 0) throw new PlanOrderError(['missing section "Changes"'])
    let end = rows.findIndex((r, i) => i > start && SECTION_HEADING.test(r))
    if (end < 0) end = rows.length
    const lines = readChanges(rows.slice(start + 1, end))
    const body = renderChanges(orderChanges(lines), repo).split('\n')
    return [...rows.slice(0, start + 1), '', ...body, ...rows.slice(end)].join(eol)
}
