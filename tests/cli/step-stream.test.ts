import { describe, it, expect } from 'vitest'
import { stepLine, resultLine, parseLine } from '@/cli/step-stream'
import type { StepEvent, RunResult } from '@/engine/types'

const step: StepEvent = { name: 'Open dashboard', status: 'passed', at: 123 }

describe('step-stream', () => {
    it('serializes a step event as one JSON line tagged type=step', () => {
        const line = stepLine(step)
        expect(line.endsWith('\n')).toBe(true)
        const parsed = JSON.parse(line)
        expect(parsed).toEqual({ type: 'step', name: 'Open dashboard', status: 'passed', at: 123 })
    })

    it('serializes a result as one JSON line tagged type=result', () => {
        const result = { ok: true, steps: [step], bundleDir: '/x' } as unknown as RunResult
        const line = resultLine(result)
        const parsed = JSON.parse(line)
        expect(parsed.type).toBe('result')
        expect(parsed.ok).toBe(true)
        expect(parsed.bundleDir).toBe('/x')
    })

    it('parseLine round-trips a step line back to an envelope', () => {
        const env = parseLine(stepLine(step))
        expect(env).toEqual({ type: 'step', name: 'Open dashboard', status: 'passed', at: 123 })
    })

    it('parseLine returns null for a non-JSON line (e.g. stray log output)', () => {
        expect(parseLine('Building app...')).toBeNull()
    })

    it('parseLine returns null for JSON without a known type', () => {
        expect(parseLine(JSON.stringify({ foo: 1 }))).toBeNull()
    })
})
