import { describe, expect, it } from 'vitest'
import { type StepEnvelope, StreamParser, stepDuration, stepsByIndex } from '@/gui/lib/stepStream'

const step = (name: string, status: string, extra: Partial<StepEnvelope> = {}): StepEnvelope => ({
    type: 'step',
    name,
    status,
    ...extra,
})

describe('StreamParser', () => {
    it('emits envelopes for complete lines and buffers partial ones', () => {
        const p = new StreamParser()
        const a = p.push('{"type":"step","name":"A","status":"running"}\n{"type":"ste')
        expect(a).toEqual([{ type: 'step', name: 'A', status: 'running' }])
        const b = p.push('p","name":"A","status":"passed"}\n')
        expect(b).toEqual([{ type: 'step', name: 'A', status: 'passed' }])
    })

    it('skips non-envelope lines (stray logs)', () => {
        const p = new StreamParser()
        const out = p.push('Building...\n{"type":"result","ok":true}\n')
        expect(out).toEqual([{ type: 'result', ok: true }])
    })

    it('emits a paused envelope', () => {
        const p = new StreamParser()
        const out = p.push('{"type":"paused","name":"Step 2: fill the proposal"}\n')
        expect(out).toEqual([{ type: 'paused', name: 'Step 2: fill the proposal' }])
    })

    it('emits an error-hold envelope', () => {
        const p = new StreamParser()
        const out = p.push(
            '{"type":"error-hold","failureCategory":"assertion","error":"expected X"}\n'
        )
        expect(out).toEqual([
            { type: 'error-hold', failureCategory: 'assertion', error: 'expected X' },
        ])
    })
})

describe('stepsByIndex', () => {
    it('collapses each running→resolved pair into one positional event', () => {
        const out = stepsByIndex([
            step('A', 'running'),
            step('A', 'passed', { screenshot: 'a.png' }),
        ])
        expect(out).toEqual([step('A', 'passed', { screenshot: 'a.png' })])
    })

    it('keeps repeated step names as SEPARATE positions (regression: study-happy-path)', () => {
        // Two same-named steps: only the FIRST has resolved so far. Name-keying
        // would mark both passed; positional keeps them distinct.
        const out = stepsByIndex([
            step('Switch to the reviewer account', 'running'),
            step('Switch to the reviewer account', 'passed', { screenshot: '1.png' }),
            step('Switch to the reviewer account', 'running'),
        ])
        expect(out).toHaveLength(2)
        expect(out[0]).toEqual(
            step('Switch to the reviewer account', 'passed', { screenshot: '1.png' })
        )
        expect(out[1]).toEqual(step('Switch to the reviewer account', 'running'))
    })

    it('preserves order across distinct steps in flight', () => {
        const out = stepsByIndex([
            step('A', 'running'),
            step('A', 'passed'),
            step('B', 'running'),
            step('B', 'failed', { error: 'boom' }),
            step('C', 'running'),
        ])
        expect(out.map(s => [s.name, s.status])).toEqual([
            ['A', 'passed'],
            ['B', 'failed'],
            ['C', 'running'],
        ])
    })

    it("carries the running event's start time onto the resolved event", () => {
        const out = stepsByIndex([
            step('A', 'running', { at: 1000 }),
            step('A', 'passed', { at: 3500 }),
        ])
        expect(out[0].startedAt).toBe(1000)
        expect(out[0].at).toBe(3500)
    })
})

describe('stepDuration', () => {
    const timed = (startedAt: number, at: number): StepEnvelope =>
        step('A', 'passed', { startedAt, at })

    it('formats sub-second as <1s', () => {
        expect(stepDuration(timed(1000, 1400))).toBe('<1s')
    })

    it('formats whole seconds under a minute', () => {
        expect(stepDuration(timed(0, 35_000))).toBe('35s')
        expect(stepDuration(timed(0, 8_400))).toBe('8s')
    })

    it('formats a minute or more as m:ss with a zero-padded seconds', () => {
        expect(stepDuration(timed(0, 83_000))).toBe('1:23')
        expect(stepDuration(timed(0, 125_000))).toBe('2:05')
    })

    it('returns null when timing is unavailable or negative', () => {
        expect(stepDuration(step('A', 'passed'))).toBeNull()
        expect(stepDuration(step('A', 'running', { at: 1000 }))).toBeNull()
        expect(stepDuration(timed(3000, 1000))).toBeNull()
    })
})
