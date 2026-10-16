import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { inventoryRenderCommand } from '@/cli/commands/inventory-render'

const minimal = {
    card: 'OTTER-1',
    target: 'qa',
    lines: [{ id: 'A.1', kind: 'check', text: 'x', source: { type: 'card', ref: 'description' } }],
}

describe('inventory-render', () => {
    const dirs: string[] = []
    afterEach(() => {
        vi.restoreAllMocks()
        for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
    })

    function tmp(): string {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qar-inv-'))
        dirs.push(dir)
        return dir
    }

    it('writes the HTML next to the input by default and prints its path and summary', async () => {
        const dir = tmp()
        const input = path.join(dir, 'OTTER-1-inventory.json')
        fs.writeFileSync(input, JSON.stringify(minimal))
        const out: string[] = []
        vi.spyOn(process.stdout, 'write').mockImplementation(s => {
            out.push(String(s))
            return true
        })
        await inventoryRenderCommand({ input })
        const printed = JSON.parse(out[0])
        expect(printed.output).toBe(path.join(dir, 'OTTER-1-inventory.html'))
        expect(printed.summary.lines).toBe(1)
        expect(fs.readFileSync(printed.output, 'utf8')).toContain('OTTER-1')
    })

    it('honours --output', async () => {
        const dir = tmp()
        const input = path.join(dir, 'inv.json')
        const output = path.join(dir, 'page.html')
        fs.writeFileSync(input, JSON.stringify(minimal))
        vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
        await inventoryRenderCommand({ input, output })
        expect(fs.existsSync(output)).toBe(true)
    })

    it('rejects a file without a lines array, naming the field', async () => {
        const dir = tmp()
        const input = path.join(dir, 'bad.json')
        fs.writeFileSync(input, JSON.stringify({ card: 'X', target: 'qa', lines: 'nope' }))
        await expect(inventoryRenderCommand({ input })).rejects.toThrow('"lines" array')
    })

    it('requires --input', async () => {
        await expect(inventoryRenderCommand({})).rejects.toThrow('--input')
    })
})
