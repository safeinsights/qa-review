import { describe, it, expect } from 'vitest'
import { frameBytes, parseInput, toCdpMouse, toCdpKey, type InputEvent } from '@/engine/screencast-codec'

describe('screencast-codec', () => {
    it('decodes a CDP base64 frame into the raw JPEG bytes to send as a binary message', () => {
        const original = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x01, 0x02]) // JPEG-ish bytes
        const base64 = original.toString('base64')
        const bytes = frameBytes(base64)
        expect(Buffer.isBuffer(bytes)).toBe(true)
        expect(bytes.equals(original)).toBe(true)
    })

    it('parses an inbound JSON input message, rejecting malformed text', () => {
        const ev = parseInput('{"kind":"mouse","action":"down","x":1,"y":2,"button":"left"}')
        expect(ev).toEqual({ kind: 'mouse', action: 'down', x: 1, y: 2, button: 'left' })
        expect(parseInput('not json')).toBeNull()
        expect(parseInput('{"kind":"bogus"}')).toBeNull()
    })

    it('maps a mousedown input event to CDP dispatchMouseEvent params', () => {
        const ev: InputEvent = { kind: 'mouse', action: 'down', x: 100, y: 50, button: 'left' }
        expect(toCdpMouse(ev)).toEqual({
            type: 'mousePressed',
            x: 100,
            y: 50,
            button: 'left',
            buttons: 1,
            clickCount: 1,
        })
    })

    it('maps a mouseup and a mousemove correctly', () => {
        expect(toCdpMouse({ kind: 'mouse', action: 'up', x: 1, y: 2, button: 'left' }).type).toBe('mouseReleased')
        const move = toCdpMouse({ kind: 'mouse', action: 'move', x: 3, y: 4, button: 'none' })
        expect(move.type).toBe('mouseMoved')
        expect(move.button).toBe('none')
        expect(move.clickCount).toBe(0)
    })

    it('maps a wheel event with deltas', () => {
        const w = toCdpMouse({ kind: 'mouse', action: 'wheel', x: 5, y: 6, button: 'none', deltaX: 0, deltaY: 120 })
        expect(w.type).toBe('mouseWheel')
        expect(w.deltaY).toBe(120)
    })

    it('maps a keydown input event to CDP dispatchKeyEvent params', () => {
        const ev: InputEvent = { kind: 'key', action: 'down', key: 'a', code: 'KeyA', text: 'a' }
        const out = toCdpKey(ev)
        expect(out.type).toBe('keyDown')
        expect(out.key).toBe('a')
        expect(out.code).toBe('KeyA')
        expect(out.text).toBe('a')
    })

    it('maps a keyup with no text', () => {
        const out = toCdpKey({ kind: 'key', action: 'up', key: 'Enter', code: 'Enter' })
        expect(out.type).toBe('keyUp')
        expect(out.text).toBeUndefined()
    })
})
