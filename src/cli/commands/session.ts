import fs from 'node:fs'
import type { Page } from '@playwright/test'
import { sessionLine } from '@/cli/step-stream'
import { loginAs, signInStopAtMfa } from '@/engine/auth'
import { launchChromeWithCdp } from '@/engine/cdp-launch'
import { resolveEnv, resolvePrEnv } from '@/engine/env'
import { createUserViaInvite } from '@/engine/flows/signup'
import { createStudyFromScratch } from '@/engine/flows/study'
import { resultsRoot, sessionRequestPath, sessionRequestResultPath } from '@/engine/paths'
import { ScreencastServer } from '@/engine/screencast'
import { acquireSessionLock } from '@/engine/session-lock'
import {
    consumeSessionRequest,
    readSessionRequest,
    type SessionAction,
    type SessionResult,
    writeSessionResult,
} from '@/engine/session-rpc'
import type { Vars } from '@/engine/settings'
import type { EnvConfig } from '@/engine/types'

// `qar session (--env <name> | --pr <n>)` — a LONG-LIVED authoring/validation
// session. Launches a browser (NOT logged in) with a CDP port, starts the
// screencast, prints `{"type":"session","cdpPort","screencastPort"}`, then stays
// alive until stdin closes or it receives SIGTERM/SIGINT.
//
// Actions are DEFERRED: instead of authenticating at startup, the session watches
// sessionRequestPath() for a request (written by a `qar session-*` client command),
// then runs it on its held browser. Supported actions:
//   - login        (`qar session-login`)        — log in as a role
//   - create-user  (`qar session-create-user`)  — invite + full signup from scratch
//   - create-study (`qar session-create-study`) — create a study proposal from scratch
// This lets Claude read a Jira ticket, infer what it needs, and only THEN trigger the
// work on the SAME browser being streamed in the Validation pane — reusing the tested
// flows instead of hand-driving selectors via the chrome-devtools MCP. `--role` is
// still accepted for backwards compatibility but is no longer used to eagerly log in.
export async function sessionCommand(opts: Record<string, string>, vars: Vars): Promise<void> {
    const env = opts.pr ? resolvePrEnv(Number(opts.pr), vars) : resolveEnv(opts.env ?? 'qa', vars)

    // Claim the single-session lock BEFORE launching Chrome: sessions share one
    // request channel, so a second one silently steals `qar session-*` requests.
    // Acquiring first means a rejected session never orphans a browser process.
    const releaseLock = acquireSessionLock()

    // Launch with a fixed CDP port (retry once if the picked port got taken).
    let launched: Awaited<ReturnType<typeof launchChromeWithCdp>>
    try {
        launched = await launchChromeWithCdp({ baseURL: env.baseURL })
    } catch (e) {
        releaseLock()
        throw e
    }
    const { browser, context, page, cdpPort } = launched

    // Land on the login page so the user (or Claude) sees a sensible starting state
    // before an on-demand login arrives.
    await page
        .goto(`${env.baseURL}/account/signin`, { waitUntil: 'domcontentloaded' })
        .catch(() => {})

    // Drop the lock even on an abnormal exit (uncaught throw), so the next session
    // isn't left reclaiming a stale file. `exit` handlers must be synchronous, which
    // the release is.
    process.on('exit', releaseLock)

    const server = await ScreencastServer.start(page)
    process.stdout.write(sessionLine({ cdpPort, screencastPort: server.port }))

    // Poll the rendezvous file for on-demand action requests. A single attachment
    // (screencast) survives navigations + loginAs(), so no re-attach is needed.
    const stopWatching = watchForRequests(page, env)

    // Stay alive until told to stop. Shutdown signals:
    //  - SIGTERM/SIGINT (Go sends SIGTERM; Ctrl-C for manual testing).
    // A keepalive timer holds the event loop open; we deliberately do NOT exit on
    // a bare immediate stdin EOF (a backgrounded/redirected process would die at
    // once), so the primary stop signal is SIGTERM.
    await new Promise<void>(resolve => {
        let stopped = false
        const keepalive = setInterval(() => {}, 1 << 30)
        const stop = () => {
            if (stopped) return
            stopped = true
            clearInterval(keepalive)
            resolve()
        }
        process.on('SIGTERM', stop)
        process.on('SIGINT', stop)
    })

    stopWatching()
    await server.close().catch(() => {})
    await context.close().catch(() => {})
    await browser.close().catch(() => {})
    releaseLock()
}

// Watch sessionRequestPath() for action requests and run each on the held page,
// writing the outcome to sessionRequestResultPath() so the client `qar session-*`
// command can report success/failure. Actions are serialized (a request that
// arrives mid-action is picked up on the next tick). Returns a stopper that clears
// the poll timer.
function watchForRequests(page: Page, env: EnvConfig): () => void {
    fs.mkdirSync(resultsRoot(), { recursive: true })
    // Clear any stale request/result from a previous session so we don't act on it.
    fs.rmSync(sessionRequestPath(), { force: true })
    fs.rmSync(sessionRequestResultPath(), { force: true })

    let busy = false
    const tick = async () => {
        if (busy) return
        const request = readSessionRequest()
        if (!request) return
        busy = true
        // Consume the request immediately so a slow action isn't re-triggered.
        consumeSessionRequest()
        try {
            const result = await runAction(page, env, request.action)
            writeSessionResult({ id: request.id, ok: true, ...result })
        } catch (e) {
            writeSessionResult({ id: request.id, ok: false, error: (e as Error).message })
        } finally {
            busy = false
        }
    }
    const timer = setInterval(() => void tick(), 300)
    return () => clearInterval(timer)
}

// Run one action on the held page and return the success fields for its result.
async function runAction(
    page: Page,
    env: EnvConfig,
    action: SessionAction
): Promise<Partial<SessionResult>> {
    switch (action.action) {
        case 'login':
            await loginAs(page, env, action.role)
            return { role: action.role }
        case 'create-user': {
            const { userId, email } = await createUserViaInvite(page, env, action.role)
            return { role: action.role, userId, email }
        }
        case 'create-study': {
            const studyId = await createStudyFromScratch(page, env)
            return { studyId }
        }
        case 'signin': {
            await signInStopAtMfa(page, env, action.email, action.password)
            return { email: action.email, atMfa: true }
        }
        default: {
            // Exhaustive at the type level, but the action arrives from a JSON file that
            // a NEWER client may have written — fail loudly instead of falling through to
            // an ok:true result with an empty payload (see assertSignedInAtMfa for the
            // client-side symptom of exactly that).
            const unknown: never = action
            throw new Error(`unknown session action: ${JSON.stringify(unknown)}`)
        }
    }
}
