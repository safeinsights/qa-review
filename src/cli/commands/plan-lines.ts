import fs from 'node:fs'
import path from 'node:path'
import type { Inventory } from '@/engine/inventory'
import { parsePlanLines } from '@/engine/plan-lines'
import { PLAN_LINES_FILE, PRS_FILE } from '@/engine/release-paths'

function flag(opts: Record<string, string>, key: string): string {
    const v = (opts[key] ?? '').trim()
    if (v === 'true') throw new Error(`plan-lines requires a value for --${key}`)
    return v
}

// The release's PR numbers, from --prs or the prs.json beside the plan. A plan with
// neither (a downloaded asset, which lives in remote/) is parsed without the gate.
function releasePrs(input: string, given: string): number[] | undefined {
    const file = given || path.join(path.dirname(input), PRS_FILE)
    if (!fs.existsSync(file)) {
        if (given) throw new Error(`--prs ${given} does not exist`)
        return undefined
    }
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as { prs?: { number: number }[] }
    if (!Array.isArray(parsed.prs)) throw new Error(`${file} has no "prs" array`)
    return parsed.prs.map(p => p.number)
}

function parseFile(input: string, tag: string, prs: string): Inventory {
    return parsePlanLines(fs.readFileSync(input, 'utf8'), tag, { prs: releasePrs(input, prs) })
}

// `qar plan-lines --input <plan.md> --tag <tag> [--output <path.json>] [--prs <prs.json>]
//                 [--security-from <local plan.md>]`
// Parses the [ID] lines out of the plan into an inventory-shaped file for
// results-check. Fails listing every problem, so a plan with a hole cannot be saved.
// --security-from adds the S- lines of the local plan: the uploaded asset has none,
// and merging here keeps the run's inventory machine-built rather than hand-edited.
export async function planLinesCommand(opts: Record<string, string>): Promise<void> {
    const input = flag(opts, 'input')
    const tag = flag(opts, 'tag')
    if (!input || !tag) throw new Error('plan-lines requires --input <plan.md> --tag <tag>')
    const inventory = parseFile(input, tag, flag(opts, 'prs'))
    const securityFrom = flag(opts, 'security-from')
    if (securityFrom) {
        const local = parseFile(securityFrom, tag, '')
        inventory.lines.push(...local.lines.filter(l => l.section === 'security'))
    }
    const output = flag(opts, 'output') || path.join(path.dirname(input), PLAN_LINES_FILE)
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
