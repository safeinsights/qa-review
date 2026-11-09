import { describe, expect, it } from 'vitest'
import { progressView, remainingText } from '@/gui/components/runProgressView'
import type { RunProgress } from '@/gui/lib/ipc'

function progress(over: Partial<RunProgress> = {}): RunProgress {
    return {
        started: true,
        line: null,
        step: '',
        note: '',
        position: 0,
        done: 0,
        total: 316,
        counts: {},
        startedAt: '2026-10-27T10:00:00Z',
        at: '2026-10-27T10:20:00Z',
        remainingSec: 0,
        ...over,
    }
}

describe('progressView', () => {
    it('waits until the session starts the run', () => {
        const v = progressView(progress({ started: false }))
        expect(v.headline).toBe('Waiting for the run to start')
        expect(v.detail).toBe('316 lines in the plan')
        expect(v.percent).toBe(0)
    })

    it('names the line under test, its group and its place', () => {
        const v = progressView(
            progress({
                line: {
                    id: '4.2',
                    title: 'Your own edit does not mark the study unread',
                    section: 'changes',
                    role: 'researcher',
                    needs: 'proposal-draft',
                    group: '4 · Researcher · study: proposal draft',
                },
                position: 120,
                note: 'Editing the draft title',
                done: 79,
                counts: { PASS: 69, FAIL: 5, 'NOT TESTED': 5 },
            })
        )
        expect(v.headline).toBe('4.2 · Your own edit does not mark the study unread')
        expect(v.detail).toBe(
            '4 · Researcher · study: proposal draft — line 120 of 316 — Editing the draft title'
        )
        expect(v.percent).toBe(25)
        expect(v.countsText).toBe('79 of 316 done · PASS 69 · FAIL 5 · NOT TESTED 5')
    })

    it('names a step between lines', () => {
        expect(
            progressView(progress({ step: 'setup', note: 'Submitting the proposal' }))
        ).toMatchObject({
            headline: 'Setting up',
            detail: 'Submitting the proposal',
        })
        expect(progressView(progress({ step: 'cleanup' })).headline).toBe('Cleaning up')
    })
})

describe('remainingText', () => {
    it('has no estimate until the pace is known', () => {
        expect(remainingText(progress())).toBe('Estimate after the first few lines')
    })

    it('rounds to minutes and hours', () => {
        expect(remainingText(progress({ remainingSec: 20 }))).toBe(
            'About 1 min left at the pace so far'
        )
        expect(remainingText(progress({ remainingSec: 5400 }))).toBe(
            'About 1 h 30 min left at the pace so far'
        )
    })

    it('says so when every line has a result', () => {
        expect(remainingText(progress({ done: 316 }))).toBe('All lines have a result')
    })
})
