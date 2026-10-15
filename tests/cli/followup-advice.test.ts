import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { followupAdviceCommand } from '@/cli/commands/followup-advice'

const tempDirs: string[] = []

function writeInput(content: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qar-fu-'))
    tempDirs.push(dir)
    const input = path.join(dir, 'fails.json')
    fs.writeFileSync(input, content)
    return input
}

describe('followup-advice', () => {
    afterEach(() => {
        vi.restoreAllMocks()
        for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
    })

    it('reads {fails:[…]} from --input and prints the recommendation', async () => {
        const input = writeInput(
            JSON.stringify({ fails: [{ id: 'a', severity: 'blocker', area: 'x' }] })
        )
        const out: string[] = []
        vi.spyOn(process.stdout, 'write').mockImplementation(s => {
            out.push(String(s))
            return true
        })
        await followupAdviceCommand({ input })
        expect(JSON.parse(out[0]).option).toBe('send-back')
    })

    it('requires --input', async () => {
        await expect(followupAdviceCommand({})).rejects.toThrow('--input')
    })

    it('treats a bare --input with no value as missing', async () => {
        await expect(followupAdviceCommand({ input: 'true' })).rejects.toThrow('--input')
    })

    it('rejects a "fails" value that is not an array', async () => {
        const input = writeInput(JSON.stringify({ fails: 'nope' }))
        await expect(followupAdviceCommand({ input })).rejects.toThrow(/"fails" array/)
    })
})
