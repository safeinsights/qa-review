import { describe, it, expect } from 'vitest'
import { StreamParser } from '@/gui/lib/stepStream'

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
})
