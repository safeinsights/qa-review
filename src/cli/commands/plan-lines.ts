import fs from 'node:fs'
import path from 'node:path'
import { parsePlanLines } from '@/engine/plan-lines'
import { PLAN_LINES_FILE } from '@/engine/release-paths'

// `qar plan-lines --input <plan.md> --tag <tag> [--output <path.json>]`
// Parses the [ID] lines out of the plan into an inventory-shaped file for
// results-check. Fails listing every problem, so a plan with a hole cannot be saved.
export async function planLinesCommand(opts: Record<string, string>): Promise<void> {
    const input = (opts.input ?? '').trim()
    const tag = (opts.tag ?? '').trim()
    if (!input || input === 'true' || !tag || tag === 'true') {
        throw new Error('plan-lines requires --input <plan.md> --tag <tag>')
    }
    const inventory = parsePlanLines(fs.readFileSync(input, 'utf8'), tag)
    const output = (opts.output ?? '').trim() || path.join(path.dirname(input), PLAN_LINES_FILE)
    fs.writeFileSync(output, JSON.stringify(inventory, null, 2))
    const counts = { changes: 0, security: 0, stagingOnly: 0 }
    for (const l of inventory.lines) {
        if (l.section === 'changes') counts.changes += 1
        if (l.section === 'security') counts.security += 1
        if (l.stagingOnly) counts.stagingOnly += 1
    }
    process.stdout.write(
        `${JSON.stringify({ ok: true, output, lines: inventory.lines.length, ...counts })}\n`
    )
}
