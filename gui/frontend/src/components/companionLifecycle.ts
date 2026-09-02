// When the run's CDP port changes, decide what to do with the companion PTY we
// already spawned. Extracted from CompanionDrawer (a .tsx the engine's tsconfig —
// which sets no --jsx — cannot typecheck) so tests/gui can cover it directly,
// the same reason validationInputs.ts is a plain module.
//
// The three outcomes exist because the companion's browser tools are bound to ONE
// port for the PTY's whole life. `writeSessionMcpConfig` bakes
// `--browserUrl=http://127.0.0.1:<port>` into a temp config that
// chrome-devtools-mcp reads once at startup; nothing rewrites it. The server DOES
// reconnect on its own — `ensureBrowserConnected` returns early only while
// `browser.connected` holds, and ToolHandler re-resolves the context on every tool
// call — but it always reconnects to that same fixed URL.
export type CompanionPortAction =
    // No spawned companion, or the port didn't really change: leave state alone.
    | 'keep'
    // The run stopped (port -> null). The browser is gone, but the conversation is
    // still worth having: the user's next question is usually "why did step 12
    // fail", answerable from the on-disk bundle via `qar` with no browser at all.
    | 'keep-stale'
    // A NEW run came up on a different port. Reap and respawn, because leaving the
    // old PTY attached is actively unsafe rather than merely useless: ports are
    // ephemeral (freePort() binds :0), so the dead port can be REUSED by an
    // unrelated process — or by this very run's Chrome — and the companion would
    // then drive a browser it only appears to understand.
    | 'respawn'

export function companionPortAction(
    prev: number | null,
    next: number | null,
    spawned: boolean
): CompanionPortAction {
    if (!spawned || prev === next) return 'keep'
    // A port arriving where there was none (the first run of this screen) is not a
    // change to react to — the spawn effect handles the initial attach.
    if (prev === null) return 'keep'
    return next === null ? 'keep-stale' : 'respawn'
}
