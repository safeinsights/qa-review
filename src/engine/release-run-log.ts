import fs from 'node:fs'
import path from 'node:path'
import { RESULT_VALUES, type ResultEntry, type ResultValue, SEVERITIES } from './results'

// The live log of one release run, written by the run session as it goes and read by
// the GUI's progress panel. Three files in .tmp/release/<tag>/, all per env:
//   run-plan-lines-<env>.json  the lines, in run order (written by plan-lines)
//   progress-<env>.json        what the session is doing now
//   results-<env>.jsonl        one result per line, appended as each line finishes
// A result that only lived in the conversation was lost when a run stopped early, and
// the GUI had no way to tell how far a run was; both read these files.

export const RUN_STEPS = ['setup', 'cleanup', 'report'] as const
export type RunStep = (typeof RUN_STEPS)[number]

export interface RunProgress {
    // The plan line being tested, or '' while the session is on a step between lines.
    line: string
    // A step between lines: a "> Next:" setup, the cleanup, or the report.
    step: RunStep | ''
    note: string
    startedAt: string
    at: string
    // Set by a resume: the pace for the time estimate counts only the lines done
    // after it, not the earlier session's.
    resumedAt?: string
    doneAtResume?: number
}

interface PlanLine {
    id: string
    title: string
}

export function runPlanLinesFile(env: string): string {
    return `run-plan-lines-${env}.json`
}

export function progressFile(env: string): string {
    return `progress-${env}.json`
}

export function resultsLogFile(env: string): string {
    return `results-${env}.jsonl`
}

export function readRunLines(dir: string, env: string): PlanLine[] {
    const file = path.join(dir, runPlanLinesFile(env))
    if (!fs.existsSync(file)) {
        throw new Error(`${runPlanLinesFile(env)} is missing — run qar plan-lines first`)
    }
    return (JSON.parse(fs.readFileSync(file, 'utf8')) as { lines: PlanLine[] }).lines
}

function writeAtomic(file: string, text: string): void {
    fs.writeFileSync(`${file}.tmp`, text)
    fs.renameSync(`${file}.tmp`, file)
}

function readProgress(dir: string, env: string): RunProgress | null {
    const file = path.join(dir, progressFile(env))
    if (!fs.existsSync(file)) return null
    return JSON.parse(fs.readFileSync(file, 'utf8')) as RunProgress
}

// A new run. The previous run's log is kept beside it under a stamped name rather than
// deleted: it can hold the only copy of results from a run that stopped early.
export function startRun(dir: string, env: string, now = new Date()): RunProgress {
    readRunLines(dir, env)
    const log = path.join(dir, resultsLogFile(env))
    if (fs.existsSync(log)) {
        fs.renameSync(log, path.join(dir, `results-${env}.${now.getTime()}.jsonl`))
    }
    const progress: RunProgress = {
        line: '',
        step: 'setup',
        note: 'Run started',
        startedAt: now.toISOString(),
        at: now.toISOString(),
    }
    writeAtomic(path.join(dir, progressFile(env)), `${JSON.stringify(progress)}\n`)
    return progress
}

export interface RunStatus {
    total: number
    done: number
    counts: Record<string, number>
    // The plan lines with no result yet, in run order.
    remaining: string[]
    // Lines whose logged result was for another title: the plan changed since, and
    // the id now names a different check. They count as remaining.
    stale: string[]
    // When the log was last written, or '' when there is no log.
    loggedAt: string
}

// How far an earlier run got. Read-only: Phase 1 shows it before asking whether to
// resume.
export function runStatus(dir: string, env: string): RunStatus {
    const { lines, byId, stale } = currentResults(dir, env)
    const counts: Record<string, number> = {}
    for (const r of byId.values()) counts[r.result] = (counts[r.result] ?? 0) + 1
    const log = path.join(dir, resultsLogFile(env))
    return {
        total: lines.length,
        done: byId.size,
        counts,
        remaining: lines.filter(l => !byId.has(l.id)).map(l => l.id),
        stale,
        loggedAt: fs.existsSync(log) ? fs.statSync(log).mtime.toISOString() : '',
    }
}

// Go on from an earlier run: the log is kept, so every line with a result is skipped.
export function resumeRun(dir: string, env: string, now = new Date()): RunProgress {
    const status = runStatus(dir, env)
    if (status.done === 0)
        throw new Error('no results to resume from — start a new run with --start')
    const previous = readProgress(dir, env)
    const progress: RunProgress = {
        line: '',
        step: 'setup',
        note: `Run resumed: ${status.done} of ${status.total} lines already have a result`,
        startedAt: previous?.startedAt ?? now.toISOString(),
        at: now.toISOString(),
        resumedAt: now.toISOString(),
        doneAtResume: status.done,
    }
    writeAtomic(path.join(dir, progressFile(env)), `${JSON.stringify(progress)}\n`)
    return progress
}

export interface ProgressUpdate {
    line?: string
    step?: string
    note?: string
}

export function recordProgress(
    dir: string,
    env: string,
    update: ProgressUpdate,
    now = new Date()
): RunProgress {
    const line = update.line ?? ''
    const step = update.step ?? ''
    if (Boolean(line) === Boolean(step)) throw new Error('give exactly one of --line or --step')
    if (line && !readRunLines(dir, env).some(l => l.id === line)) {
        throw new Error(`${line} is not a line of ${runPlanLinesFile(env)}`)
    }
    if (step && !RUN_STEPS.includes(step as RunStep)) {
        throw new Error(`--step is one of ${RUN_STEPS.join(', ')}`)
    }
    const previous = readProgress(dir, env)
    if (!previous) throw new Error('no run in progress — start one with --start')
    const progress: RunProgress = {
        line,
        step: step as RunStep | '',
        note: update.note ?? '',
        startedAt: previous.startedAt,
        at: now.toISOString(),
        ...(previous.resumedAt
            ? { resumedAt: previous.resumedAt, doneAtResume: previous.doneAtResume ?? 0 }
            : {}),
    }
    writeAtomic(path.join(dir, progressFile(env)), `${JSON.stringify(progress)}\n`)
    return progress
}

function isBlank(value: unknown): boolean {
    return typeof value !== 'string' || value.trim() === ''
}

// The rules results-check applies to one entry, checked when the result is written so
// a bad entry is fixed while the line is still on screen, not at the end of the run.
export function entryProblems(entry: ResultEntry, ids: Set<string>): string[] {
    const problems: string[] = []
    if (!ids.has(entry.id)) problems.push(`${entry.id} is not a line of the run`)
    if (!RESULT_VALUES.includes(entry.result as ResultValue)) {
        problems.push(`--result is one of ${RESULT_VALUES.join(', ')}`)
    }
    if (isBlank(entry.evidence)) problems.push('--evidence is required')
    if (entry.result === 'FAIL') {
        if (!SEVERITIES.includes(entry.severity as (typeof SEVERITIES)[number])) {
            problems.push(`a FAIL needs --severity (${SEVERITIES.join(', ')})`)
        }
        if (isBlank(entry.area)) problems.push('a FAIL needs --area')
    }
    if (entry.result === 'NOT TESTED' && isBlank(entry.approvedBy)) {
        problems.push('a NOT TESTED needs --approved-by')
    }
    return problems
}

export function appendResult(dir: string, env: string, entry: ResultEntry): void {
    const ids = new Set(readRunLines(dir, env).map(l => l.id))
    const problems = entryProblems(entry, ids)
    if (problems.length) throw new Error(problems.join('\n'))
    // The title goes into the log so a resume can tell a result for this check from
    // one for a check that had the same id before the plan was edited.
    const title = readRunLines(dir, env).find(l => l.id === entry.id)?.title
    const clean = Object.fromEntries(
        Object.entries({ ...entry, title }).filter(
            ([, v]) => typeof v === 'string' && v.trim() !== ''
        )
    )
    fs.appendFileSync(path.join(dir, resultsLogFile(env)), `${JSON.stringify(clean)}\n`)
}

// The latest result per line: a line tested again replaces its earlier result.
export function readResultsLog(dir: string, env: string): Map<string, ResultEntry> {
    const file = path.join(dir, resultsLogFile(env))
    const byId = new Map<string, ResultEntry>()
    if (!fs.existsSync(file)) return byId
    for (const raw of fs.readFileSync(file, 'utf8').split('\n')) {
        if (!raw.trim()) continue
        const entry = JSON.parse(raw) as ResultEntry
        byId.set(entry.id, entry)
    }
    return byId
}

// The logged results that still belong to the plan's lines. Ids are positions in the
// plan, so a plan edited since the log was written can give an id to another check;
// a result logged with a different title is stale, not done. A result with no title
// (written before titles were logged) is taken as it is.
function currentResults(
    dir: string,
    env: string
): { lines: PlanLine[]; byId: Map<string, ResultEntry>; stale: string[] } {
    const lines = readRunLines(dir, env)
    const logged = readResultsLog(dir, env) as Map<string, ResultEntry & { title?: string }>
    const byId = new Map<string, ResultEntry>()
    const stale: string[] = []
    for (const line of lines) {
        const entry = logged.get(line.id)
        if (!entry) continue
        if (entry.title && entry.title !== line.title) {
            stale.push(line.id)
            continue
        }
        const { title: _title, ...result } = entry
        byId.set(line.id, result)
    }
    return { lines, byId, stale }
}

export const STOPPED_EVIDENCE = 'Run stopped by the runner before this line was tested.'

// results-<env>.json in run order. A line with no result is an error, unless the
// runner stopped the run: then it is NOT TESTED, approved by the runner.
export function buildResults(
    dir: string,
    env: string,
    stoppedBy = ''
): { results: ResultEntry[]; missing: string[] } {
    const { lines, byId: logged } = currentResults(dir, env)
    const missing = lines.filter(l => !logged.has(l.id)).map(l => l.id)
    if (missing.length && !stoppedBy) {
        throw new Error(
            `${missing.length} line(s) have no result: ${missing.join(', ')} — test them, ` +
                'or pass --stopped-by <runner> if the runner stopped the run'
        )
    }
    const results = lines.map(
        l =>
            logged.get(l.id) ?? {
                id: l.id,
                result: 'NOT TESTED' as const,
                approvedBy: stoppedBy,
                evidence: STOPPED_EVIDENCE,
            }
    )
    writeAtomic(path.join(dir, `results-${env}.json`), `${JSON.stringify({ results }, null, 2)}\n`)
    return { results, missing }
}
