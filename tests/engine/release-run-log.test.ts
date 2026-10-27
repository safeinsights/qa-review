import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
    appendResult,
    buildResults,
    readResultsLog,
    recordProgress,
    resumeRun,
    runStatus,
    STOPPED_EVIDENCE,
    startRun,
} from '@/engine/release-run-log'

let dir: string

function writeLines(ids: string[]): void {
    const lines = ids.map(id => ({ id, title: `Line ${id}` }))
    fs.writeFileSync(path.join(dir, 'run-plan-lines-staging.json'), JSON.stringify({ lines }))
}

function progress() {
    return JSON.parse(fs.readFileSync(path.join(dir, 'progress-staging.json'), 'utf8'))
}

beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'run-log-'))
    writeLines(['BASELINE', '1.1', '1.2'])
})
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

describe('release run progress', () => {
    it('starts a run and keeps its start time across later updates', () => {
        startRun(dir, 'staging', new Date('2026-10-27T10:00:00Z'))
        recordProgress(
            dir,
            'staging',
            { line: '1.1', note: 'HSTS header' },
            new Date('2026-10-27T10:05:00Z')
        )
        expect(progress()).toMatchObject({
            line: '1.1',
            step: '',
            note: 'HSTS header',
            startedAt: '2026-10-27T10:00:00.000Z',
            at: '2026-10-27T10:05:00.000Z',
        })
    })

    it('refuses a line that is not in the run', () => {
        startRun(dir, 'staging')
        expect(() => recordProgress(dir, 'staging', { line: '9.9' })).toThrow(/not a line/)
    })

    it('takes exactly one of a line or a step', () => {
        startRun(dir, 'staging')
        expect(() => recordProgress(dir, 'staging', {})).toThrow(/exactly one/)
        expect(() => recordProgress(dir, 'staging', { line: '1.1', step: 'setup' })).toThrow(
            /exactly one/
        )
        expect(() => recordProgress(dir, 'staging', { step: 'lunch' })).toThrow(/--step is one of/)
    })

    it('needs a started run', () => {
        expect(() => recordProgress(dir, 'staging', { line: '1.1' })).toThrow(/--start/)
    })

    it('keeps the previous run log instead of deleting it', () => {
        startRun(dir, 'staging')
        appendResult(dir, 'staging', { id: '1.1', result: 'PASS', evidence: 'seen' })
        startRun(dir, 'staging', new Date(1_000))
        expect(fs.existsSync(path.join(dir, 'results-staging.jsonl'))).toBe(false)
        expect(fs.existsSync(path.join(dir, 'results-staging.1000.jsonl'))).toBe(true)
    })
})

describe('release run results', () => {
    beforeEach(() => startRun(dir, 'staging'))

    it('applies the results-check rules when a result is written', () => {
        expect(() =>
            appendResult(dir, 'staging', { id: '1.1', result: 'FAIL', evidence: 'broke' })
        ).toThrow(/--severity[\s\S]*--area/)
        expect(() =>
            appendResult(dir, 'staging', { id: '1.1', result: 'NOT TESTED', evidence: 'skipped' })
        ).toThrow(/--approved-by/)
        expect(() =>
            appendResult(dir, 'staging', { id: '1.1', result: 'PASS', evidence: ' ' })
        ).toThrow(/--evidence/)
        expect(readResultsLog(dir, 'staging').size).toBe(0)
    })

    it('lets a later result for a line replace the earlier one', () => {
        appendResult(dir, 'staging', { id: '1.1', result: 'PASS', evidence: 'first' })
        appendResult(dir, 'staging', {
            id: '1.1',
            result: 'FAIL',
            evidence: 'second',
            severity: 'minor',
            area: 'headers',
        })
        expect(readResultsLog(dir, 'staging').get('1.1')?.result).toBe('FAIL')
    })

    it('refuses to build results with a line missing, unless the runner stopped the run', () => {
        appendResult(dir, 'staging', { id: '1.1', result: 'PASS', evidence: 'seen' })
        expect(() => buildResults(dir, 'staging')).toThrow(/BASELINE, 1.2/)
        const { results, missing } = buildResults(dir, 'staging', 'Runner Name')
        expect(missing).toEqual(['BASELINE', '1.2'])
        expect(results.map(r => r.id)).toEqual(['BASELINE', '1.1', '1.2'])
        expect(results[2]).toEqual({
            id: '1.2',
            result: 'NOT TESTED',
            approvedBy: 'Runner Name',
            evidence: STOPPED_EVIDENCE,
        })
        const written = JSON.parse(fs.readFileSync(path.join(dir, 'results-staging.json'), 'utf8'))
        expect(written.results).toHaveLength(3)
    })
})

describe('resuming a release run', () => {
    beforeEach(() => {
        startRun(dir, 'staging', new Date('2026-10-27T10:00:00Z'))
        appendResult(dir, 'staging', { id: 'BASELINE', result: 'PASS', evidence: 'report' })
        appendResult(dir, 'staging', {
            id: '1.1',
            result: 'FAIL',
            evidence: 'broke',
            severity: 'minor',
            area: 'headers',
        })
    })

    it('reports how far the earlier run got, without writing', () => {
        const before = fs.readFileSync(path.join(dir, 'progress-staging.json'), 'utf8')
        expect(runStatus(dir, 'staging')).toMatchObject({
            total: 3,
            done: 2,
            counts: { PASS: 1, FAIL: 1 },
            remaining: ['1.2'],
        })
        expect(fs.readFileSync(path.join(dir, 'progress-staging.json'), 'utf8')).toBe(before)
    })

    it('keeps the log and the first start time, and marks where the resume began', () => {
        resumeRun(dir, 'staging', new Date('2026-10-28T09:00:00Z'))
        expect(readResultsLog(dir, 'staging').size).toBe(2)
        expect(progress()).toMatchObject({
            startedAt: '2026-10-27T10:00:00.000Z',
            resumedAt: '2026-10-28T09:00:00.000Z',
            doneAtResume: 2,
        })
        recordProgress(dir, 'staging', { line: '1.2' }, new Date('2026-10-28T09:05:00Z'))
        expect(progress()).toMatchObject({
            line: '1.2',
            resumedAt: '2026-10-28T09:00:00.000Z',
            doneAtResume: 2,
        })
    })

    it('counts a result logged for another title as stale, not done', () => {
        const lines = [
            { id: 'BASELINE', title: 'Line BASELINE' },
            { id: '1.1', title: 'A different check after a plan edit' },
            { id: '1.2', title: 'Line 1.2' },
        ]
        fs.writeFileSync(path.join(dir, 'run-plan-lines-staging.json'), JSON.stringify({ lines }))
        expect(runStatus(dir, 'staging')).toMatchObject({
            done: 1,
            remaining: ['1.1', '1.2'],
            stale: ['1.1'],
        })
        const { results } = buildResults(dir, 'staging', 'Runner Name')
        expect(results[1]).toMatchObject({ id: '1.1', result: 'NOT TESTED' })
        expect(results[0]).not.toHaveProperty('title')
    })

    it('refuses to resume when nothing was logged', () => {
        startRun(dir, 'staging')
        expect(() => resumeRun(dir, 'staging')).toThrow(/--start/)
    })
})
