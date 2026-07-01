import { describe, it, expect } from 'vitest'
import { frameBytes, parseInput, toCdpMouse, toCdpKey, cursorMessage, urlMessage, clipboardMessage, consoleMessage, mapConsoleLevel, type InputEvent } from '@/engine/screencast-codec'

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

    it('forwards modifiers and suppresses text for a non-shift-modified shortcut', () => {
        // Cmd+C (Meta=4): modifier forwarded, but no `text` — it's a shortcut,
        // not a typed character, so it must not insert a "c".
        const out = toCdpKey({ kind: 'key', action: 'down', key: 'c', code: 'KeyC', text: 'c', modifiers: 4 })
        expect(out.modifiers).toBe(4)
        expect(out.text).toBeUndefined()
    })

    it('keeps text for a Shift-only modified key (uppercase letter)', () => {
        // Shift (8) alone is text entry, not a shortcut → keep the text.
        const out = toCdpKey({ kind: 'key', action: 'down', key: 'A', code: 'KeyA', text: 'A', modifiers: 8 })
        expect(out.modifiers).toBe(8)
        expect(out.text).toBe('A')
    })

    it('serializes a cursor update message', () => {
        expect(cursorMessage('pointer')).toBe('{"type":"cursor","value":"pointer"}')
        expect(JSON.parse(cursorMessage('text'))).toEqual({ type: 'cursor', value: 'text' })
    })

    it('falls back to default for blank cursor values', () => {
        expect(JSON.parse(cursorMessage('')).value).toBe('default')
        expect(JSON.parse(cursorMessage('   ')).value).toBe('default')
        expect(JSON.parse(cursorMessage('  pointer  ')).value).toBe('pointer')
    })

    it('serializes a url update message', () => {
        expect(urlMessage('https://qa.safeinsights.org/study/42')).toBe('{"type":"url","value":"https://qa.safeinsights.org/study/42"}')
        expect(JSON.parse(urlMessage('about:blank'))).toEqual({ type: 'url', value: 'about:blank' })
    })

    it('serializes a clipboard update message', () => {
        expect(JSON.parse(clipboardMessage('hello world'))).toEqual({ type: 'clipboard', value: 'hello world' })
        expect(JSON.parse(clipboardMessage(''))).toEqual({ type: 'clipboard', value: '' })
    })

    it('parses clipboard input events (read has no value; write requires a string value)', () => {
        expect(parseInput('{"kind":"clipboard-read"}')).toEqual({ kind: 'clipboard-read' })
        expect(parseInput('{"kind":"clipboard-write","value":"pasted"}')).toEqual({ kind: 'clipboard-write', value: 'pasted' })
        // clipboard-write without a string value is rejected as malformed.
        expect(parseInput('{"kind":"clipboard-write"}')).toBeNull()
        expect(parseInput('{"kind":"clipboard-write","value":42}')).toBeNull()
    })

    it('serializes a console line message', () => {
        expect(JSON.parse(consoleMessage({ level: 'error', text: 'boom', at: 5, url: 'x.js' }))).toEqual({
            type: 'console',
            line: { level: 'error', text: 'boom', at: 5, url: 'x.js' },
        })
    })

    it('maps Playwright console types to our five levels', () => {
        expect(mapConsoleLevel('warning')).toBe('warn')
        expect(mapConsoleLevel('trace')).toBe('debug')
        expect(mapConsoleLevel('error')).toBe('error')
        expect(mapConsoleLevel('info')).toBe('info')
        expect(mapConsoleLevel('log')).toBe('log')
        // Unknown/unhandled types fall back to 'log'.
        expect(mapConsoleLevel('table')).toBe('log')
        expect(mapConsoleLevel('dir')).toBe('log')
    })
})
