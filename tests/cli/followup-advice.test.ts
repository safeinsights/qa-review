import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { followupAdviceCommand } from '@/cli/commands/followup-advice'

describe('followup-advice', () => {
    afterEach(() => {
        vi.restoreAllMocks()
    })

    it('reads {fails:[…]} from --input and prints the recommendation', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qar-fu-'))
        const input = path.join(dir, 'fails.json')
        fs.writeFileSync(
            input,
            JSON.stringify({ fails: [{ id: 'a', severity: 'blocker', area: 'x' }] })
        )
        const out: string[] = []
        vi.spyOn(process.stdout, 'write').mockImplementation(s => {
            out.push(String(s))
            return true
        })
        await followupAdviceCommand({ input })
        expect(JSON.parse(out[0]).option).toBe('send-back')
        fs.rmSync(dir, { recursive: true, force: true })
    })

    it('requires --input', async () => {
        await expect(followupAdviceCommand({})).rejects.toThrow('--input')
    })
})
