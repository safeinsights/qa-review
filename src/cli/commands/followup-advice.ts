import fs from 'node:fs'
import { type Fail, recommendFollowUp } from '@/engine/followup'

// `qar followup-advice --input <path.json>` — reads the validation's results file
// (or a bare list of FAILs) and returns the routing suggestion.
export async function followupAdviceCommand(opts: Record<string, string>): Promise<void> {
    // A bare `--input` with no value parses to 'true', which is not a path.
    const input = (opts.input ?? '').trim()
    if (!input || input === 'true') throw new Error('followup-advice requires --input <path.json>')
    const parsed = JSON.parse(fs.readFileSync(input, 'utf8')) as {
        fails?: unknown
        results?: unknown
    }
    // The results file (`qar results-check`) is the normal input; its FAIL entries
    // carry the same severity/area fields. A bare {fails:[…]} is still accepted.
    const fails = Array.isArray(parsed.results)
        ? (parsed.results as (Fail & { result?: string })[]).filter(r => r.result === 'FAIL')
        : parsed.fails
    if (!Array.isArray(fails)) {
        throw new Error('followup-advice: --input JSON must have a "results" or "fails" array')
    }
    const result = recommendFollowUp(fails as Fail[])
    process.stdout.write(`${JSON.stringify(result)}\n`)
}
