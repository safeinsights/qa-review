import { describe, expect, it } from 'vitest'
import { companionPortAction } from '../../gui/frontend/src/components/companionLifecycle'

describe('companionPortAction', () => {
    it('keeps a stopped run’s companion so the conversation survives', () => {
        // The bug this encodes: dropping the session on stop meant a stop/start
        // cycle lost the whole conversation AND left a live PTY the next spawn
        // collided with ("a session is already running").
        expect(companionPortAction(9222, null, true)).toBe('keep-stale')
    })

    it('respawns when a NEW run comes up on a different port', () => {
        // Not merely stale — ports are ephemeral and can be reused, so keeping the
        // old session risks driving an unrelated browser.
        expect(companionPortAction(9222, 9333, true)).toBe('respawn')
    })

    it('does nothing when no companion was ever spawned', () => {
        expect(companionPortAction(9222, null, false)).toBe('keep')
        expect(companionPortAction(9222, 9333, false)).toBe('keep')
    })

    it('does nothing when the port is unchanged', () => {
        expect(companionPortAction(9222, 9222, true)).toBe('keep')
        expect(companionPortAction(null, null, true)).toBe('keep')
    })

    it('treats the first port arriving as no change', () => {
        // Nothing is spawned yet; the lazy-spawn effect owns the initial attach.
        expect(companionPortAction(null, 9222, false)).toBe('keep')
    })

    it('respawns a stopped run’s companion when a new run starts', () => {
        // stop (9222 -> null) then start (null -> 9333). Keeping it here left the
        // session bound to the dead port with the "run stopped" banner still showing.
        expect(companionPortAction(null, 9333, true)).toBe('respawn')
    })
})
