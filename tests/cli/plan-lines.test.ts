import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { planLinesCommand } from '@/cli/commands/plan-lines'
import { stripSecurity } from '@/engine/public-plan'

const PLAN = `# Regression plan v1

## Summary
x

## Baseline
- [BASELINE] Run release-happy-path — qar run

## Changes
### 1. Researcher · no study
- 1.1 t — s ([PR #1](https://github.com/o/r/pull/1))

## Security
- [S-1] Redirect — probe (staging only)

## Technical appendix
y
`

let dir: string
beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qar-plan-lines-'))
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
})
afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
    vi.restoreAllMocks()
})

const prs = (numbers: number[]) => JSON.stringify({ prs: numbers.map(number => ({ number })) })

describe('plan-lines', () => {
    it('applies the completeness gate from the prs.json beside the input', async () => {
        const input = path.join(dir, 'plan.md')
        fs.writeFileSync(input, PLAN)
        fs.writeFileSync(path.join(dir, 'prs.json'), prs([1, 2]))
        await expect(planLinesCommand({ input, tag: 'v1' })).rejects.toThrow(
            /PR #2 has no test line/
        )
    })

    it('takes --prs from elsewhere and fails on a missing --prs file', async () => {
        const input = path.join(dir, 'plan.md')
        fs.writeFileSync(input, PLAN)
        const other = path.join(dir, 'other.json')
        fs.writeFileSync(other, prs([1]))
        await planLinesCommand({ input, tag: 'v1', prs: other })
        await expect(
            planLinesCommand({ input, tag: 'v1', prs: path.join(dir, 'nope.json') })
        ).rejects.toThrow(/does not exist/)
    })

    it('--security-from adds the local S- lines to the public plan', async () => {
        const local = path.join(dir, 'plan.md')
        fs.writeFileSync(local, PLAN)
        fs.mkdirSync(path.join(dir, 'remote'))
        const input = path.join(dir, 'remote', 'testing-plan.md')
        fs.writeFileSync(input, stripSecurity(PLAN))
        const output = path.join(dir, 'run-plan-lines-staging.json')
        await planLinesCommand({ input, tag: 'v1', 'security-from': local, output })
        const ids = JSON.parse(fs.readFileSync(output, 'utf8')).lines.map(
            (l: { id: string }) => l.id
        )
        expect(ids).toEqual(['BASELINE', '1.1', 'S-1'])
    })
})
