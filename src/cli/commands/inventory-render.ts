import fs from 'node:fs'
import path from 'node:path'
import { type Inventory, renderInventoryHtml, summarize } from '@/engine/inventory'

// `qar inventory-render --input <path.json> [--output <path.html>]`
//
// Renders the requirement inventory a validation session wrote to a single
// self-contained HTML page, so the user can review ~60 lines in the session browser
// instead of a terminal dump. Prints {"output","summary"} — the summary is what the
// session repeats in chat when it asks for approval.
export async function inventoryRenderCommand(opts: Record<string, string>): Promise<void> {
    const input = (opts.input ?? '').trim()
    if (!input || input === 'true') throw new Error('inventory-render requires --input <path.json>')
    const parsed = JSON.parse(fs.readFileSync(input, 'utf8')) as Partial<Inventory>
    if (!Array.isArray(parsed.lines)) {
        throw new Error('inventory-render: --input JSON must have a "lines" array')
    }
    const inventory: Inventory = {
        card: String(parsed.card ?? ''),
        target: String(parsed.target ?? ''),
        lines: parsed.lines,
    }
    const output = (opts.output ?? '').trim() || `${input.replace(/\.json$/i, '')}.html`
    fs.mkdirSync(path.dirname(output), { recursive: true })
    fs.writeFileSync(output, renderInventoryHtml(inventory))
    process.stdout.write(
        `${JSON.stringify({ output: path.resolve(output), summary: summarize(inventory) })}\n`
    )
}
