import fs from 'node:fs'
import { type Fail, recommendFollowUp } from '@/engine/followup'

// `qar followup-advice --input <path.json>` — the skill writes its FAILs with a
// severity and an area, and asks this for the routing suggestion.
export async function followupAdviceCommand(opts: Record<string, string>): Promise<void> {
    // A bare `--input` with no value parses to 'true', which is not a path.
    const input = (opts.input ?? '').trim()
    if (!input || input === 'true') throw new Error('followup-advice requires --input <path.json>')
    const parsed = JSON.parse(fs.readFileSync(input, 'utf8')) as { fails?: unknown }
    if (!Array.isArray(parsed.fails)) {
        throw new Error('followup-advice: --input JSON must have a "fails" array')
    }
    const result = recommendFollowUp(parsed.fails as Fail[])
    process.stdout.write(`${JSON.stringify(result)}\n`)
}
