import fs from 'node:fs'
import { type Fail, recommendFollowUp } from '@/engine/followup'

// `qar followup-advice --input <path.json>` — the skill writes its FAILs with a
// severity and an area, and asks this for the routing suggestion.
export async function followupAdviceCommand(opts: Record<string, string>): Promise<void> {
    const input = (opts.input ?? '').trim()
    if (!input) throw new Error('followup-advice requires --input <path.json>')
    const parsed = JSON.parse(fs.readFileSync(input, 'utf8')) as { fails?: Fail[] }
    const result = recommendFollowUp(parsed.fails ?? [])
    process.stdout.write(`${JSON.stringify(result)}\n`)
}
