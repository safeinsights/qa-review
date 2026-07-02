import { describe, expect, it } from 'vitest'
import { buildRunState } from '@/engine/run-state'
import type { RunResult, StepEvent } from '@/engine/types'

const step = (over: Partial<StepEvent>): StepEvent =>
    ({ name: 'X', status: 'running', at: 0, ...over }) as StepEvent

describe('buildRunState', () => {
    it('collapses running→resolved into one entry per position, preserving order', () => {
        const events: StepEvent[] = [
            step({ name: 'A', status: 'running' }),
            step({ name: 'A', status: 'passed', screenshot: 'screenshots/01-a.png' }),
            step({ name: 'B', status: 'running' }),
            step({ name: 'B', status: 'failed', error: 'boom' }),
        ]
        const rs = buildRunState(events)
        expect(rs.steps.map(s => [s.name, s.status])).toEqual([
            ['A', 'passed'],
            ['B', 'failed'],
        ])
        expect(rs.steps[0].screenshot).toBe('screenshots/01-a.png')
        expect(rs.steps[1].error).toBe('boom')
        expect(rs.result).toBeUndefined()
        expect(rs.running).toBe(true)
    })

    it('includes the final result and marks running=false when given one', () => {
        const result = {
            ok: false,
            steps: [],
            bundleDir: '/tmp/b',
            failureCategory: 'app-assertion',
        } as unknown as RunResult
        const rs = buildRunState([], result)
        expect(rs.result?.ok).toBe(false)
        expect(rs.running).toBe(false)
    })
})
