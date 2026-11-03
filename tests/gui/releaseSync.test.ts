import { describe, expect, it } from 'vitest'
import { decideReload } from '@/gui/components/releaseSync'

describe('decideReload', () => {
    it("ignores the editor's own write coming back", () => {
        expect(
            decideReload({
                incomingHash: 'h1',
                lastWrittenHash: 'h1',
                loadedHash: 'h0',
                dirty: false,
            })
        ).toBe('ignore')
    })
    it('ignores a hash the editor already holds', () => {
        expect(
            decideReload({
                incomingHash: 'h1',
                lastWrittenHash: null,
                loadedHash: 'h1',
                dirty: false,
            })
        ).toBe('ignore')
    })
    it('reloads a foreign change when the buffer is saved', () => {
        expect(
            decideReload({
                incomingHash: 'h2',
                lastWrittenHash: 'h1',
                loadedHash: 'h1',
                dirty: false,
            })
        ).toBe('reload')
    })
    it('asks when the buffer has unsaved keystrokes', () => {
        expect(
            decideReload({
                incomingHash: 'h2',
                lastWrittenHash: 'h1',
                loadedHash: 'h1',
                dirty: true,
            })
        ).toBe('ask')
    })
    it('ignores a hash the editor holds even when the buffer is dirty', () => {
        expect(
            decideReload({
                incomingHash: 'h1',
                lastWrittenHash: null,
                loadedHash: 'h1',
                dirty: true,
            })
        ).toBe('ignore')
    })
})
