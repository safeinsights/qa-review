import fs from 'node:fs'
import { managementAppRepo } from '@/engine/jira-keys'
import { reorderPlan } from '@/engine/plan-order'
import type { Vars } from '@/engine/settings'

// `qar plan-order --input <plan.md>` — sort the Changes section into run order and
// number it, in place. Run after the plan is written and after any edit to Changes,
// so the plan always reads in the order it is run.
export async function planOrderCommand(opts: Record<string, string>, vars: Vars): Promise<void> {
    const input = (opts.input ?? '').trim()
    if (!input || input === 'true') throw new Error('plan-order requires --input <plan.md>')
    const before = fs.readFileSync(input, 'utf8')
    const after = reorderPlan(before, managementAppRepo(vars))
    if (after !== before) fs.writeFileSync(input, after)
    process.stdout.write(`${JSON.stringify({ ok: true, input, changed: after !== before })}\n`)
}
