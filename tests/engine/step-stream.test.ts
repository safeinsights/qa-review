import { describe, expect, it } from 'vitest'
import { parseControlLine, parseLine, screencastLine, stepFailedLine } from '@/cli/step-stream'

describe('screencast envelope carries cdpPort', () => {
    it('round-trips port and cdpPort', () => {
        const line = screencastLine({ port: 9001, cdpPort: 9222 })
        const env = parseLine(line.trim())
        expect(env).toEqual({ type: 'screencast', port: 9001, cdpPort: 9222 })
    })
})

describe('step-failed envelope', () => {
    it('round-trips the failed step index/name/error', () => {
        const line = stepFailedLine({
            index: 3,
            stepName: 'Reviewer decrypts and views the results',
            error: 'locator.click: Timeout 30000ms exceeded',
            failureCategory: 'app-assertion',
        })
        const env = parseLine(line.trim())
        expect(env).toMatchObject({
            type: 'step-failed',
            index: 3,
            stepName: 'Reviewer decrypts and views the results',
            failureCategory: 'app-assertion',
        })
    })
})

describe('retry-step / give-up control messages', () => {
    it('parses retry-step and give-up, and rejects unknown types', () => {
        expect(parseControlLine('{"type":"retry-step"}')).toEqual({ type: 'retry-step' })
        expect(parseControlLine('{"type":"give-up"}')).toEqual({ type: 'give-up' })
        expect(parseControlLine('{"type":"nope"}')).toBeNull()
    })
})
