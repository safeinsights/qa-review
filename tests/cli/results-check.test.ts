import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { resultsCheckCommand } from '@/cli/commands/results-check'

const inventory = {
    card: 'OTTER-1',
    target: 'qa',
    lines: [
        {
            id: 'A.1',
            title: 'A one',
            kind: 'check',
            text: 'a',
            source: { type: 'card', ref: 'description' },
        },
        {
            id: 'A.2',
            title: 'A two',
            kind: 'check',
            text: 'b',
            source: { type: 'card', ref: 'description' },
        },
    ],
}

describe('results-check', () => {
    const dirs: string[] = []
    const out: string[] = []
    afterEach(() => {
        vi.restoreAllMocks()
        out.length = 0
        for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
    })

    function files(results: unknown): { inventory: string; results: string } {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qar-rc-'))
        dirs.push(dir)
        const inv = path.join(dir, 'inv.json')
        const res = path.join(dir, 'res.json')
        fs.writeFileSync(inv, JSON.stringify(inventory))
        fs.writeFileSync(res, JSON.stringify(results))
        vi.spyOn(process.stdout, 'write').mockImplementation(s => {
            out.push(String(s))
            return true
        })
        return { inventory: inv, results: res }
    }

    it('prints the counts and exits cleanly when every line is covered', async () => {
        const opts = files({
            results: [
                { id: 'A.1', result: 'PASS', evidence: 'x' },
                { id: 'A.2', result: 'FAIL', severity: 'minor', area: 'copy', evidence: 'y' },
            ],
        })
        await resultsCheckCommand(opts)
        expect(JSON.parse(out[0])).toMatchObject({ ok: true, counts: { PASS: 1, FAIL: 1 } })
    })

    it('throws naming every problem so the session cannot post', async () => {
        const opts = files({ results: [{ id: 'A.1', result: 'PASS', evidence: 'x' }] })
        await expect(resultsCheckCommand(opts)).rejects.toThrow('A.2: no result')
    })

    it('requires a results array', async () => {
        const opts = files({ nope: [] })
        await expect(resultsCheckCommand(opts)).rejects.toThrow('"results" array')
    })
})
