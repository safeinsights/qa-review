import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
import type { GhRunner } from '@/cli/commands/open-access-pr'
import { managementAppRepo } from '@/engine/jira-keys'
import { repoDir } from '@/engine/paths'
import { PLAN_FILE, releaseDir } from '@/engine/release-paths'
import { extractSummary, updateReleaseSummary } from '@/engine/release-summary'
import type { Vars } from '@/engine/settings'

const execFileAsync = promisify(execFile)
const realGh: GhRunner = async args =>
    (await execFileAsync('gh', args, { cwd: repoDir(), maxBuffer: 16 * 1024 * 1024 })).stdout

// `qar release-summary --tag <tag> [--input <plan.md>]` — copy the plan's Summary
// into the release description, above the PR table, so the release page itself
// says what changed.
export async function releaseSummaryCommand(
    opts: Record<string, string>,
    vars: Vars,
    gh: GhRunner = realGh
): Promise<void> {
    const tag = (opts.tag ?? '').trim()
    if (!tag || tag === 'true') throw new Error('release-summary requires --tag <tag>')
    const input = (opts.input ?? '').trim() || path.join(releaseDir(tag), PLAN_FILE)
    if (input === 'true') throw new Error('release-summary requires a value for --input')
    const summary = extractSummary(fs.readFileSync(input, 'utf8'))
    const placement = await updateReleaseSummary(gh, managementAppRepo(vars), tag, summary)
    process.stdout.write(`${JSON.stringify({ tag, chars: summary.length, placement })}\n`)
}
