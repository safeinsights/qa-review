import { describe, expect, it } from 'vitest'
import { jumpToLine, parseControlLine } from '@/cli/step-stream'

// The CLI's stdin reader is a hand-rolled NDJSON splitter. This exercises the exact
// buffering it does, so a jump-to arriving split across chunks (as it can over a
// pipe) still parses — the failure mode a naive line-split would hide.
function drain(chunks: string[]): unknown[] {
    let buf = ''
    const out: unknown[] = []
    for (const chunk of chunks) {
        buf += chunk
        let nl = buf.indexOf('\n')
        while (nl >= 0) {
            const line = buf.slice(0, nl)
            buf = buf.slice(nl + 1)
            const msg = parseControlLine(line)
            if (msg) out.push(msg)
            nl = buf.indexOf('\n')
        }
    }
    return out
}

describe('jump-to over the stdin control channel', () => {
    it('parses a whole line', () => {
        expect(drain([jumpToLine(3)])).toEqual([{ type: 'jump-to', index: 3 }])
    })

    it('parses a line split across chunks', () => {
        const line = jumpToLine(12)
        const cut = 8
        expect(drain([line.slice(0, cut), line.slice(cut)])).toEqual([
            { type: 'jump-to', index: 12 },
        ])
    })

    it('parses several control messages batched in one chunk', () => {
        expect(drain([jumpToLine(1) + jumpToLine(2)])).toEqual([
            { type: 'jump-to', index: 1 },
            { type: 'jump-to', index: 2 },
        ])
    })
})
