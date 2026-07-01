import { describe, it, expect } from 'vitest'
import { stepLine, resultLine, parseLine, pausedLine, pauseSetLine, resumeLine, parseControlLine } from '@/cli/step-stream'
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

    it('round-trips a paused envelope', () => {
        const env = parseLine(pausedLine({ name: 'Step 2: fill the proposal' }))
        expect(env).toEqual({ type: 'paused', name: 'Step 2: fill the proposal' })
    })
})

describe('step-stream control channel (inbound)', () => {
    it('parses a resume message', () => {
        expect(parseControlLine(resumeLine())).toEqual({ type: 'resume' })
    })

    it('parses a pause-set message with a step list', () => {
        expect(parseControlLine(pauseSetLine(['A', 'B']))).toEqual({ type: 'pause-set', steps: ['A', 'B'] })
    })

    it('parses an empty pause-set (all pauses cleared)', () => {
        expect(parseControlLine(pauseSetLine([]))).toEqual({ type: 'pause-set', steps: [] })
    })

    it('returns null for non-JSON, unknown type, or a malformed pause-set', () => {
        expect(parseControlLine('not json')).toBeNull()
        expect(parseControlLine(JSON.stringify({ type: 'nope' }))).toBeNull()
        expect(parseControlLine(JSON.stringify({ type: 'pause-set', steps: [1, 2] }))).toBeNull()
        expect(parseControlLine(JSON.stringify({ type: 'pause-set' }))).toBeNull()
    })
})
