import fs from 'node:fs'
import type { Inventory } from '@/engine/inventory'
import { checkResults, type ResultEntry } from '@/engine/results'

// `qar results-check --inventory <path.json> --results <path.json>`
//
// The gate before a verdict is posted: every check line has one evidenced result,
// FAILs carry severity and area, NOT TESTED carries the approver, observed lines
// are FAILs. Prints {"ok","counts"} on success; throws listing every gap otherwise,
// so a report with a hole in it cannot be posted by accident.
export async function resultsCheckCommand(opts: Record<string, string>): Promise<void> {
    const inventoryPath = (opts.inventory ?? '').trim()
    const resultsPath = (opts.results ?? '').trim()
    if (!inventoryPath || inventoryPath === 'true' || !resultsPath || resultsPath === 'true') {
        throw new Error('results-check requires --inventory <path.json> --results <path.json>')
    }
    const inventory = JSON.parse(fs.readFileSync(inventoryPath, 'utf8')) as Partial<Inventory>
    if (!Array.isArray(inventory.lines)) {
        throw new Error('results-check: --inventory JSON must have a "lines" array')
    }
    const parsed = JSON.parse(fs.readFileSync(resultsPath, 'utf8')) as { results?: unknown }
    if (!Array.isArray(parsed.results)) {
        throw new Error('results-check: --results JSON must have a "results" array')
    }
    const report = checkResults(inventory as Inventory, parsed.results as ResultEntry[])
    if (!report.ok) {
        throw new Error(
            `results-check found ${report.problems.length} problem(s):\n${report.problems.join('\n')}`
        )
    }
    process.stdout.write(`${JSON.stringify({ ok: true, counts: report.counts })}\n`)
}
