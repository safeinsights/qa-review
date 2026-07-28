import fs from 'node:fs'
import { resultsRoot, verdictPostedPath } from '@/engine/paths'

// `qar verdict-posted --issue <KEY> --result <validated|rejected>` — record that a
// verdict was just posted to Jira, so the GUI can hide the Verdict button and show
// the outcome. Claude calls this right after it posts a verdict comment + transitions
// the ticket (whether the GUI's Verdict button drove it or the user asked directly).
// Writes `{ issue, result }` to a rendezvous file the running validation session polls.
export async function verdictPostedCommand(opts: Record<string, string>): Promise<void> {
    const issue = (opts.issue ?? '').trim()
    if (!issue) throw new Error('verdict-posted requires --issue <KEY>')
    const result = (opts.result ?? '').trim().toLowerCase()
    if (result !== 'validated' && result !== 'rejected') {
        throw new Error(`--result must be one of validated, rejected (got "${opts.result ?? ''}")`)
    }

    fs.mkdirSync(resultsRoot(), { recursive: true })
    const tmp = `${verdictPostedPath()}.tmp`
    fs.writeFileSync(tmp, JSON.stringify({ issue, result }))
    fs.renameSync(tmp, verdictPostedPath())
    process.stdout.write(`${JSON.stringify({ issue, result })}\n`)
}
