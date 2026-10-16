import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { clockCommand } from '@/cli/commands/clock'

describe('clock', () => {
    const dirs: string[] = []
    const out: string[] = []
    afterEach(() => {
        vi.restoreAllMocks()
        out.length = 0
        for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
    })

    function file(): string {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qar-clock-'))
        dirs.push(dir)
        vi.spyOn(process.stdout, 'write').mockImplementation(s => {
            out.push(String(s))
            return true
        })
        return path.join(dir, 'OTTER-1-clock.json')
    }

    it('creates the file on the first mark and appends on the next', async () => {
        const clock = file()
        await clockCommand({ file: clock, mark: 'start' })
        await clockCommand({ file: clock, mark: 'inventory' })
        const marks = JSON.parse(fs.readFileSync(clock, 'utf8')).marks
        expect(marks.map((m: { phase: string }) => m.phase)).toEqual(['start', 'inventory'])
        expect(JSON.parse(out[1]).marks).toBe(2)
    })

    it('prints the summary line with --report', async () => {
        const clock = file()
        await clockCommand({ file: clock, mark: 'start' })
        await clockCommand({ file: clock, report: 'true' })
        expect(out[1]).toMatch(/^Total < 1 min/)
    })

    it('requires --mark or --report, and --file', async () => {
        await expect(clockCommand({ file: 'x' })).rejects.toThrow('--mark')
        await expect(clockCommand({ mark: 'start' })).rejects.toThrow('--file')
    })
})
