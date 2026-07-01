import { describe, it, expect } from 'vitest'
import { screencastLine, parseLine } from '@/cli/step-stream'

describe('screencast envelope carries cdpPort', () => {
    it('round-trips port and cdpPort', () => {
        const line = screencastLine({ port: 9001, cdpPort: 9222 })
        const env = parseLine(line.trim())
        expect(env).toEqual({ type: 'screencast', port: 9001, cdpPort: 9222 })
    })
})
