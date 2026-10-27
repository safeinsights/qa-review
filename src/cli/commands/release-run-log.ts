import { releaseDir } from '@/engine/release-paths'
import {
    appendResult,
    buildResults,
    readResultsLog,
    recordProgress,
    resumeRun,
    runStatus,
    startRun,
} from '@/engine/release-run-log'
import type { ResultEntry, ResultValue } from '@/engine/results'

function value(opts: Record<string, string>, name: string): string {
    const v = (opts[name] ?? '').trim()
    return v === 'true' ? '' : v
}

function runDir(opts: Record<string, string>): { dir: string; env: string } {
    const tag = value(opts, 'tag')
    if (!tag) throw new Error('this command requires --tag <release tag>')
    const env = value(opts, 'env')
    if (env !== 'staging' && env !== 'production') {
        throw new Error('this command requires --env staging|production')
    }
    return { dir: releaseDir(tag), env }
}

function print(v: unknown): void {
    process.stdout.write(`${JSON.stringify(v)}\n`)
}

// `qar release-progress --tag <tag> --env <env> (--status | --start | --resume |
// --line <id> | --step <step>) [--note <text>]` — tell the GUI what the run session
// is doing now, or (--status) report how far an earlier run got.
export async function releaseProgressCommand(opts: Record<string, string>): Promise<void> {
    const { dir, env } = runDir(opts)
    const modes = ['status', 'start', 'resume'].filter(m => opts[m] === 'true')
    if (modes.length > 1) throw new Error('give only one of --status, --start, --resume')
    if (modes[0] === 'status') return print(runStatus(dir, env))
    if (modes[0] === 'start') return print(startRun(dir, env))
    if (modes[0] === 'resume') return print(resumeRun(dir, env))
    print(
        recordProgress(dir, env, {
            line: value(opts, 'line') || undefined,
            step: value(opts, 'step') || undefined,
            note: value(opts, 'note'),
        })
    )
}

// `qar release-result --tag <tag> --env <env> --id <id> --result <R> --evidence <text>
// [--severity <s>] [--area <a>] [--approved-by <name>]` — append one line's result.
export async function releaseResultCommand(opts: Record<string, string>): Promise<void> {
    const { dir, env } = runDir(opts)
    const entry: ResultEntry = {
        id: value(opts, 'id'),
        result: value(opts, 'result').toUpperCase() as ResultValue,
        evidence: value(opts, 'evidence'),
        severity: (value(opts, 'severity') || undefined) as ResultEntry['severity'],
        area: value(opts, 'area') || undefined,
        approvedBy: value(opts, 'approved-by') || undefined,
    }
    appendResult(dir, env, entry)
    const counts: Record<string, number> = {}
    for (const r of readResultsLog(dir, env).values())
        counts[r.result] = (counts[r.result] ?? 0) + 1
    print({ id: entry.id, result: entry.result, counts })
}

// `qar release-results --tag <tag> --env <env> [--stopped-by <runner>]` — write
// results-<env>.json from the log, in run order.
export async function releaseResultsCommand(opts: Record<string, string>): Promise<void> {
    const { dir, env } = runDir(opts)
    const { results, missing } = buildResults(dir, env, value(opts, 'stopped-by'))
    print({
        output: `.tmp/release/${value(opts, 'tag')}/results-${env}.json`,
        lines: results.length,
        filled: missing.length,
    })
}
