import path from 'node:path'
import { AuthError, loginAs } from '@/engine/auth'
import { CleanupClient } from '@/engine/cleanup'
import { resolveEnv } from '@/engine/env'
import { resultsRoot as resultsRootDir } from '@/engine/paths'
import { Recorder } from '@/engine/recorder'
import { buildRunState, truncateEventsToPosition } from '@/engine/run-state'
import { mapConsoleLevel } from '@/engine/screencast-codec'
import { getSuite } from '@/engine/suite-registry'
import type {
    ConsoleLine,
    FailureCategory,
    RunRequest,
    RunResult,
    RunState,
    StepEvent,
} from '@/engine/types'
import type { RunContext, Suite } from '@/suites/types'

export interface BrowserHandle {
    page: import('@playwright/test').Page
    cookieHeader: string
    // The Chrome remote-debugging port this browser exposes, if launched with one
    // (production runs do; test fakes may omit). Lets the run companion attach.
    cdpPort?: number
    close: () => Promise<void>
    // Stop tracing into <bundleDir>/trace.zip. Called BEFORE close() (tracing must
    // stop while the context is still open). Optional so test fakes can omit it.
    saveTraceTo?: (bundleDir: string) => Promise<void>
    saveVideoTo?: (bundleDir: string) => Promise<void>
}

// Injectable dependencies — production defaults in defaultDeps(); tests pass fakes.
export interface RunDeps {
    vars: Record<string, string | undefined>
    resultsRoot: string
    openBrowser: (env: { name: string; baseURL: string }) => Promise<BrowserHandle>
    login: (
        handle: BrowserHandle,
        env: ReturnType<typeof resolveEnv>,
        role: RunRequest['role'],
        bundleDir: string
    ) => Promise<string>
    runCleanup: (client: CleanupClient) => Promise<RunResult['cleanup']>
    // Optional live step sink (the CLI --json mode prints each event). When
    // omitted, runs proceed without streaming.
    onStep?: (event: StepEvent) => void
    // Called once with the live Playwright page just after it's created, so a
    // caller (the CLI --screencast mode) can attach a screencast to it.
    onPage?: (page: import('@playwright/test').Page) => void | Promise<void>
    // Called ONCE with the run's bundle dir, right after the recorder is created
    // (before any step) — so a live consumer knows where to write run-state.json.
    onBundleDir?: (dir: string) => void
    // Called with the accumulated snapshot after each step event AND once with the
    // final result. The CLI persists it to <bundleDir>/run-state.json.
    onRunState?: (state: RunState) => void
    // Pause-before-step control (the CLI wires these to a stdin control channel).
    // Consulted before each step: if shouldPause returns true, onPaused fires and
    // the run blocks on waitForResume until the user resumes. All optional so a
    // run without a controller proceeds straight through.
    shouldPause?: (stepName: string) => boolean
    waitForResume?: () => Promise<void>
    onPaused?: (stepName: string) => void
    // Jump-to-step control. Read at the TOP of each step iteration: if a target is
    // latched, the loop relocates there and continues from it. Returns the target
    // index and clears the latch (so it fires once), or undefined for "no jump".
    // A step already in flight can't be interrupted — there's no cancellation in the
    // engine — so a jump requested mid-step is honored when that step finishes.
    consumeJump?: () => number | undefined
    // Hold-open-on-failure control. When a run FAILS (a step throws / login fails
    // / the browser won't open) AND this hook is wired, the engine fires
    // onErrorHold and then blocks on waitForResume — keeping the browser alive so
    // the run companion (Claude) can attach to the CDP port and drive the frozen
    // failure state. Teardown (close browser, save trace/video) is deferred until
    // resume/stop arrives. Optional: without the hook, a failed run tears down
    // immediately (the existing behavior for CLI-only runs and tests).
    onErrorHold?: (info: { failureCategory?: FailureCategory; error?: string }) => void
    // In-process step retry (GUI only). When a STEP throws AND these are wired, the
    // engine holds the browser open (like onErrorHold) and, instead of tearing down,
    // waits for the user's decision: 'retry' re-runs the SAME-index step against the
    // live ctx after reloading the (possibly edited) suite from disk; 'giveUp' fails
    // the run. This is DISTINCT from onErrorHold, which stays for the non-retryable
    // failures that happen outside the step loop (login / openBrowser). Wired only
    // together — without them a step throw rethrows to the outer catch (CLI/tests).
    onStepFailed?: (info: {
        index: number
        stepName: string
        error: string
        failureCategory: FailureCategory
    }) => void
    // 'jump' means a jump-to arrived while the run was held on a failed step: the
    // loop consumes the latched target instead of retrying this index.
    waitForResolution?: () => Promise<'retry' | 'giveUp' | 'jump'>
    // Reload ONE suite from disk and return the fresh Suite (or throw on a load
    // error). Called on retry so an edited suite's new code is picked up. Injected so
    // tests fake it; production is a cache-busting dynamic import of the .ts (tsx).
    reloadSuite?: (name: string) => Promise<Suite>
}

function categorize(error: Error): FailureCategory {
    if (error instanceof AuthError) return 'auth'
    const m = error.message.toLowerCase()
    if (
        m.includes('econnrefused') ||
        m.includes('net::') ||
        m.includes('timeout') ||
        m.includes('5xx')
    )
        return 'environment'
    // A failed web-first assertion / visibility wait reads as a real app issue.
    if (m.includes('visible') || m.includes('expect') || m.includes('tobe')) return 'app-assertion'
    return 'tool-crash'
}

// A step body has no deadline of its own. Playwright's per-action defaults bound each
// click and assertion, but a bare `expect(...).toPass()` resolves its timeout to 0 in
// LIBRARY mode (no test runner, so no expect config to read) and therefore polls
// forever. A step that can never succeed then hangs the whole run instead of failing:
// no failure row, no screenshot, run-state.json frozen mid-step, and the browser never
// held open for a retry. Observed for 8 minutes on an env whose build simply did not
// have the page the step navigated to.
//
// So every ctx.step() gets a wall-clock deadline. Exceeding it fails the step through
// the ordinary path — screenshot, url, console, retryable hold — with a message naming
// the limit. The word 'timeout' in that message categorizes it as 'environment', which
// is how a plain Playwright timeout already reads.
const DEFAULT_STEP_TIMEOUT_MS = 5 * 60 * 1000

// `QAR_STEP_TIMEOUT_MS` overrides it; 0 disables the deadline (an escape hatch for
// hand-debugging a parked step). A non-numeric or negative value falls back to the
// default instead of silently disabling the guard.
export function resolveStepTimeoutMs(vars: Record<string, string | undefined>): number {
    const raw = vars.QAR_STEP_TIMEOUT_MS
    if (raw === undefined || raw.trim() === '') return DEFAULT_STEP_TIMEOUT_MS
    const parsed = Number(raw)
    if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_STEP_TIMEOUT_MS
    return Math.floor(parsed)
}

// Thrown when an abandoned attempt tries to keep driving the browser. It is not a
// suite failure: the step it belongs to was already recorded failed when its deadline
// fired, and this rejection only unwinds a body that no longer has a reader.
export class StepAbandonedError extends Error {
    constructor() {
        super(
            'step deadline already fired — this attempt was abandoned and must stop driving the page'
        )
        this.name = 'StepAbandonedError'
    }
}

// Wrap `page` so every action it (or anything reached through it) performs first
// checks that the caller is still the live attempt.
//
// Playwright has no cancellation, so a timed-out body keeps running. Asking each
// suite to poll `ctx.signal` by hand is the kind of contract that holds until the
// first helper forgets — and from inside a body a zombie is indistinguishable from
// normal execution. Guarding at the object boundary makes it automatic instead:
// nothing downstream can touch the browser without passing this check.
//
// Locators, frames, and the like are wrapped on the way out too, since that is where
// most interaction actually happens (`page.getByRole(...).click()` never calls a
// method on `page` itself).
function guardPage<T extends object>(
    target: T,
    generationAtEntry: () => number,
    currentGeneration: () => number
): T {
    // Read-only accessors stay unguarded: a zombie reading page.url() is harmless,
    // and throwing there would break the engine's own currentUrl()/screenshot paths,
    // which legitimately run after a deadline fires to record the failure.
    const readOnly = new Set(['url', 'isClosed', 'context', 'video', 'coverage'])
    return new Proxy(target, {
        get(obj, prop, receiver) {
            const value = Reflect.get(obj, prop, receiver)
            if (typeof value !== 'function' || typeof prop !== 'string' || readOnly.has(prop)) {
                return value
            }
            return (...args: unknown[]) => {
                if (currentGeneration() !== generationAtEntry()) throw new StepAbandonedError()
                const out = (value as (...a: unknown[]) => unknown).apply(obj, args)
                // Locator/Frame/ElementHandle come back here; wrap them so the check
                // rides along instead of stopping at the first hop.
                if (out && typeof out === 'object' && !(out instanceof Promise)) {
                    return guardPage(out as object, generationAtEntry, currentGeneration)
                }
                return out
            }
        },
    })
}

export async function withStepDeadline<T>(
    name: string,
    timeoutMs: number,
    action: () => Promise<T>,
    onTimeout?: () => void
): Promise<T> {
    if (timeoutMs <= 0) return action()
    const pending = action()
    // Playwright has no cancellation, so an abandoned body keeps polling until
    // teardown. Swallow its eventual rejection here: without this it surfaces as an
    // unhandled rejection long after the step was already recorded failed.
    pending.catch(() => {})
    const seconds = Math.round(timeoutMs / 1000)
    const message =
        `Step "${name}" hit the ${seconds}s step timeout with no result — it is stuck, ` +
        'not slow (raise or disable it with QAR_STEP_TIMEOUT_MS)'
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
        return await Promise.race([
            pending,
            new Promise<never>((_resolve, reject) => {
                timer = setTimeout(() => {
                    // Signal the abandonment BEFORE rejecting, so by the time the retry
                    // loop regains control the zombie body is already marked stale.
                    onTimeout?.()
                    reject(new Error(message))
                }, timeoutMs)
            }),
        ])
    } finally {
        clearTimeout(timer)
    }
}

// Validate a latched jump target and do the recorder bookkeeping so the run can
// continue from it. Returns the target index, or undefined when there's nothing to
// do (no request, already there, or out of range).
//
// The two directions need OPPOSITE bookkeeping to keep the GUI's positional step
// list aligned (it maps suite step names onto executed positions by index):
//   BACKWARD — the target already ran, so drop its rows and everything after;
//              re-running re-occupies them instead of appending duplicates.
//   FORWARD  — nothing ran for the skipped steps, so emit a 'skipped' event per step
//              to occupy their positions. Without these the checklist would shift and
//              light up the wrong rows.
//
// `fromRan` says whether step `from` already produced a row: false at a step boundary
// (it hasn't run yet, so a forward jump skips it too), true when jumping out of a
// FAILED step (its failure row is real and must be preserved, not overwritten).
export function applyJumpTo(
    target: number | undefined,
    ctx: {
        from: number
        fromRan: boolean
        steps: Suite['steps']
        events: StepEvent[]
        recorder: Recorder
        stepStartPositions: number[]
        onRunState?: (state: RunState) => void
    }
): number | undefined {
    const { from, fromRan, steps, events, recorder, stepStartPositions } = ctx
    // Bounds are checked HERE (not at parse time) because a retry-reload can change
    // the live suite's length. An out-of-range target is ignored, not fatal.
    if (target === undefined || target === from) return undefined
    if (!Number.isInteger(target) || target < 0 || target >= steps.length) return undefined
    if (target < from) {
        const position = stepStartPositions[target] ?? 0
        truncateEventsToPosition(events, position)
        recorder.dropFrom(position)
    } else {
        for (let s = fromRan ? from + 1 : from; s < target; s++) {
            recorder.step(steps[s].name, 'skipped')
        }
    }
    ctx.onRunState?.(buildRunState(events))
    return target
}

// One step boundary: consume a latched jump, else run the pause gate and check for a
// jump once more on resume (the GUI releases a pause by resuming, so a jump requested
// while parked arrives here). Returns the index to relocate to, or undefined to run
// the step as normal.
async function stepBoundary(
    i: number,
    deps: {
        stepName: string
        applyJump: (from: number) => number | undefined
        shouldPause?: (stepName: string) => boolean
        onPaused?: (stepName: string) => void
        waitForResume?: () => Promise<void>
    }
): Promise<number | undefined> {
    const jump = deps.applyJump(i)
    if (jump !== undefined) return jump
    if (!deps.shouldPause?.(deps.stepName)) return undefined
    deps.onPaused?.(deps.stepName)
    await deps.waitForResume?.()
    return deps.applyJump(i)
}

// Await the user's decision on a failed step and translate it into what the run loop
// should do: 'giveUp' (fail the run), 'retry' (re-run this index), 'hold' (a jump with
// no valid target — keep holding), or a number (jump to that index).
async function resolveStepFailure(
    waitForResolution: () => Promise<'retry' | 'giveUp' | 'jump'>,
    i: number,
    applyJump: (from: number, fromRan: boolean) => number | undefined
): Promise<'giveUp' | 'retry' | 'hold' | number> {
    const decision = await waitForResolution()
    if (decision !== 'jump') return decision
    const target = applyJump(i, true)
    return target ?? 'hold'
}

export async function runEngine(
    req: RunRequest,
    deps: RunDeps,
    suiteOverride?: Suite
): Promise<RunResult> {
    const startedAt = Date.now()
    const mode = req.mode ?? 'suite'
    const env = req.envConfig ?? resolveEnv(req.env, deps.vars)
    const suite = suiteOverride ?? (await getSuite(req.suite))
    const stepTimeoutMs = resolveStepTimeoutMs(deps.vars)

    // Collected step events for a future live-streaming consumer (e.g. the CLI/GUI
    // progress view). Not read here; recorder.finish() is the source of truth for steps.
    const events: StepEvent[] = []
    const recorder = new Recorder(
        {
            root: deps.resultsRoot,
            suite: suite.name,
            env: env.name,
            role: req.role,
            mode,
            startedAt,
        },
        e => {
            events.push(e)
            deps.onStep?.(e)
            deps.onRunState?.(buildRunState(events))
        }
    )
    // Emit the bundle dir before any step so a live consumer knows where to
    // write run-state.json (recorder.bundleDir is ready right after construction).
    deps.onBundleDir?.(recorder.bundleDir)

    const cleanup = new CleanupClient(env.baseURL, '')
    const tag = `qa-${suite.name}-${startedAt}`

    let ok = true
    let failureCategory: FailureCategory | undefined
    let handle: BrowserHandle | undefined
    let cleanupResult: RunResult['cleanup'] = { ok: true, deleted: [], failed: [] }
    // Set once a step failure has already been offered to the retry channel (the user
    // chose 'giveUp'), so the outer catch doesn't hold the browser a SECOND time via
    // onErrorHold. Non-retryable failures (login / openBrowser) leave this false and
    // still get the error-hold.
    let stepFailureResolved = false

    try {
        handle = await deps.openBrowser({ name: env.name, baseURL: env.baseURL })

        const page = handle.page
        // Attach the live view + console capture BEFORE login, so the screencast
        // and console see every page load from the very first — including the
        // login flow (e.g. the on-load Clerk "development keys" warning).
        await deps.onPage?.(page)

        let authToken: string
        try {
            authToken = await deps.login(handle, env, req.role, recorder.bundleDir)
        } catch (cause) {
            // A failure in the login phase is always an auth failure, regardless
            // of the thrown error's class (tests inject a plain Error).
            throw new AuthError((cause as Error).message)
        }
        // The cleanup client authorizes with the logged-in user's Clerk session
        // JWT (Bearer). deps.login returns it (loginAs -> getClerkToken).
        ;(cleanup as unknown as { authToken: string }).authToken = authToken

        let stepIndex = 0
        const captureScreenshot = async (label: string): Promise<string | undefined> => {
            // Best-effort per-step still saved into the bundle. The recorder stays
            // Playwright-free; we hand it only the bundle-relative path. A capture
            // failure must never fail the step.
            const slug = label
                .replace(/[^a-z0-9]+/gi, '-')
                .toLowerCase()
                .slice(0, 40)
            const rel = path.join(
                'screenshots',
                `${String(++stepIndex).padStart(2, '0')}-${slug}.png`
            )
            try {
                // fullPage: capture the entire scrollable page, not just the
                // 1280×720 viewport, so the snapshot shows the whole page (the GUI
                // scrolls it within a fixed-size pane).
                //
                // `style` is injected only for the duration of this shot (Playwright
                // reverts it afterward). fullPage expands the viewport to the page's
                // scroll height and takes ONE shot — which leaves the app's
                // fixed-position footer stranded mid-image as a dark band. Hide just
                // the footer for the capture so the page reads top-to-bottom cleanly.
                await page.screenshot({
                    path: path.join(recorder.bundleDir, rel),
                    fullPage: true,
                    style: '.mantine-AppShell-footer{ display: none !important }',
                })
                return rel
            } catch {
                return undefined
            }
        }
        // Best-effort top-frame URL for the step's metadata — like the screenshot,
        // a failure here must never fail the step.
        const currentUrl = (): string | undefined => {
            try {
                return page.url()
            } catch {
                return undefined
            }
        }
        // Per-step console capture: buffer every console.* line + uncaught page
        // error for the whole run; ctx.step drains the slice accumulated since the
        // previous step. A single attachment survives navigations and loginAs().
        const consoleBuf: ConsoleLine[] = []
        const onConsole = (msg: import('@playwright/test').ConsoleMessage) =>
            consoleBuf.push({
                level: mapConsoleLevel(msg.type()),
                text: msg.text(),
                at: Date.now(),
                url: msg.location()?.url,
            })
        const onPageError = (err: Error) =>
            consoleBuf.push({ level: 'error', text: String(err?.stack || err), at: Date.now() })
        page.on('console', onConsole)
        page.on('pageerror', onPageError)
        // Drain the console captured since the previous step (best-effort metadata;
        // undefined when a step logged nothing, matching currentUrl's optionality).
        const drainConsole = (): ConsoleLine[] | undefined => {
            const lines = consoleBuf.splice(0)
            return lines.length ? lines : undefined
        }
        // Tracks the currently signed-in role so ctx.account stays correct across
        // mid-run loginAs() switches. Starts as the role the run logged in with.
        let currentRole = req.role
        // The name of the step whose run() is currently executing, so a body may
        // call ctx.step(action) WITHOUT repeating the step's name. Set by the step
        // loop before each step.run(ctx); the ctx.step closure reads the live value.
        let currentStepName = ''
        // A timed-out step body cannot be cancelled (Playwright has no cancellation),
        // so it keeps driving `handle.page` after the deadline fires. The retry re-runs
        // step.run() against that SAME page, meaning a zombie attempt's clicks and
        // navigations can land underneath the live one. Each attempt therefore carries a
        // generation; `abandonAttempt` bumps it, and `ctx.signal` reports whether the
        // caller is still the live attempt.
        let attemptGeneration = 0
        const abandonAttempt = () => {
            attemptGeneration++
        }
        const generationAtCall = () => attemptGeneration
        // The page each body sees. `guardedPageFor(gen)` binds the generation the body
        // was entered at, so the guard compares that fixed value against the live
        // counter — a body started before a deadline fired is rejected once the
        // counter moves past it, while the retry (entered at the new generation) runs
        // freely.
        const guardedPageFor = (enteredAt: number) =>
            guardPage(
                page,
                () => enteredAt,
                () => attemptGeneration
            )
        const ctx: RunContext = {
            // Guarded rather than raw. Relying on every body to check ctx.signal by hand
            // would be a contract that rots on the first helper that forgets — and the
            // bodies are exactly the code least likely to remember, since a zombie is
            // invisible from inside. Guarding the page means one seam covers every
            // suite and every flow helper, including ones not written yet.
            //
            // A getter, so the generation is bound WHEN THE BODY READS ctx.page — which
            // is inside the body, before its deadline can have fired. A body that read
            // the page, then timed out, keeps its stale binding and starts throwing;
            // the retry reads ctx.page afresh and gets a current one. Helpers that
            // captured the page as an argument are covered too, since the object they
            // hold carries the binding with it.
            get page() {
                return guardedPageFor(attemptGeneration)
            },
            baseURL: env.baseURL,
            tag,
            // Getter so it reflects the LATEST loginAs() switch, not the role at
            // ctx-construction time.
            get account() {
                const a = env.accounts[currentRole]
                return { email: a.email, password: a.password, mfaCode: a.mfaCode }
            },
            // Live-attempt check for suite bodies. Captured at property-read time, so a
            // body that grabbed `ctx.signal` before its deadline fired still sees
            // `aborted` flip to true once the retry has moved on.
            get signal(): { readonly aborted: boolean } {
                const mine = generationAtCall()
                return {
                    get aborted() {
                        return attemptGeneration !== mine
                    },
                }
            },
            async step<T>(a: string | (() => Promise<T>), b?: () => Promise<T>): Promise<T> {
                // Overloaded: step(action) records under the enclosing step's name;
                // step(name, action) uses the explicit name.
                const name: string = typeof a === 'function' ? currentStepName : a
                const action: () => Promise<T> =
                    typeof a === 'function' ? a : (b as () => Promise<T>)
                recorder.step(name, 'running')
                try {
                    const out = await withStepDeadline(name, stepTimeoutMs, action, abandonAttempt)
                    const screenshot = await captureScreenshot(name)
                    recorder.step(name, 'passed', {
                        screenshot,
                        url: currentUrl(),
                        console: drainConsole(),
                    })
                    return out
                } catch (cause) {
                    const screenshot = await captureScreenshot(name)
                    recorder.step(name, 'failed', {
                        error: (cause as Error).message,
                        screenshot,
                        url: currentUrl(),
                        console: drainConsole(),
                    })
                    throw cause
                }
            },
            trackStudy: id => cleanup.trackStudy(id),
            trackUser: id => cleanup.trackUser(id),
            // Results are decrypted as the reviewer, so surface the reviewer
            // account's private key. Undefined when unset (the suite errors clearly).
            resultsKey: env.accounts.reviewer.privateKey,
            async loginAs(role) {
                // Guaranteed clean slate before re-authenticating. Visiting
                // /account/signin while still signed in trips the app's
                // auto-signout (the sign-in form renders null while it clears the
                // session), which races the form hydration. Clearing cookies +
                // web storage first lands loginAs() on a hydrated, logged-out form.
                await handle?.page.context().clearCookies()
                await handle?.page
                    .evaluate(() => {
                        try {
                            localStorage.clear()
                            sessionStorage.clear()
                        } catch {
                            // storage may be inaccessible on some pages; best-effort.
                        }
                    })
                    .catch(() => {})
                if (!handle) throw new Error('loginAs called before the browser was opened')
                // Re-drive Clerk as the new role (auth.ts navigates to /signin itself).
                const newToken = await deps.login(handle, env, role, recorder.bundleDir)
                // Track the switch so ctx.account now returns the new role's creds.
                currentRole = role
                // Keep id-based cleanup authorized as the now-current user.
                ;(cleanup as unknown as { authToken: string }).authToken = newToken
            },
            // Per-run scratch bag threaded between steps (replaces the shared
            // locals a single run() body used to close over).
            state: {},
        }

        // Number of executed step positions so far (a step body may call ctx.step
        // more than once; each opens a position). Captured before a step runs so a
        // retry can truncate the recorder/run-state back to exactly this step's rows.
        const executedPositions = () =>
            events.reduce(
                (n, e) => n + (e.status === 'running' || e.status === 'skipped' ? 1 : 0),
                0
            )

        // Run the suite's steps in order. The pause gate sits BEFORE each step so
        // the browser idles at the boundary — the user can interact with the live
        // Chrome, then resume — before any of the step's actions fire.
        //
        // `liveSuite` may be swapped for a freshly-reloaded copy on retry (below), so
        // steps AFTER a fixed one also pick up the edit. Indexed (not for-of) so the
        // retry can re-run the same position after reloading.
        let liveSuite = suite
        // Recorder position each step index began at, so a BACKWARD jump can truncate
        // to the target's rows exactly as a retry does for the current step.
        const stepStartPositions: number[] = []

        const applyJump = (from: number, fromRan: boolean): number | undefined =>
            applyJumpTo(deps.consumeJump?.(), {
                from,
                fromRan,
                steps: liveSuite.steps,
                events,
                recorder,
                stepStartPositions,
                onRunState: deps.onRunState,
            })
        // The step boundary: honor a latched jump, then the pause gate, then check for
        // a jump ONE more time (the GUI releases a pause by resuming, so a jump sent
        // while parked lands here). Returns a jump target to relocate to, or undefined
        // to run the step at `i`.
        const atBoundary = (i: number) =>
            stepBoundary(i, {
                stepName: liveSuite.steps[i].name,
                applyJump: from => applyJump(from, false),
                shouldPause: deps.shouldPause,
                onPaused: deps.onPaused,
                waitForResume: deps.waitForResume,
            })

        steps: for (let i = 0; i < liveSuite.steps.length; i++) {
            const jump = await atBoundary(i)
            if (jump !== undefined) {
                i = jump - 1 // the loop's i++ lands us on `jump`
                continue
            }
            let step = liveSuite.steps[i]
            // Recorder position where THIS step begins — the truncation point for a
            // retry (so the failed step's rows are dropped and the retry re-occupies
            // them instead of appending duplicates).
            const positionAtStepStart = executedPositions()
            stepStartPositions[i] = positionAtStepStart
            // Inner retry loop for this index. Breaks out on success; a 'giveUp' or a
            // run without the retry deps rethrows to the outer catch (existing behavior).
            for (;;) {
                try {
                    // So a body may call ctx.step(action) without repeating the name.
                    // Set inside the retry loop so a reloaded step records under its
                    // (possibly renamed) name.
                    currentStepName = step.name
                    await step.run(ctx)
                    break
                } catch (cause) {
                    // No retry channel wired (CLI runs, engine tests): preserve the
                    // original behavior — rethrow to the outer catch, which optionally
                    // holds via onErrorHold then tears down.
                    if (!deps.waitForResolution || !deps.reloadSuite) throw cause
                    deps.onStepFailed?.({
                        index: i,
                        stepName: step.name,
                        error: (cause as Error).message,
                        failureCategory: categorize(cause as Error),
                    })
                    // Browser HELD OPEN here — the companion inspects/edits, then the
                    // user chooses retry, give up, or jumps to another step. A jump
                    // KEEPS the failed step's rows (the failure is real and worth
                    // showing); an invalid target holds so the user can choose again.
                    const outcome = await resolveStepFailure(deps.waitForResolution, i, applyJump)
                    if (outcome === 'giveUp') {
                        stepFailureResolved = true
                        throw cause
                    }
                    if (outcome === 'hold') continue
                    if (typeof outcome === 'number') {
                        i = outcome - 1 // the outer loop's i++ lands us on `outcome`
                        continue steps
                    }
                    // Retry: reload the (possibly edited) suite. A compile error keeps
                    // the browser held so the user can fix the edit and retry again.
                    try {
                        liveSuite = await deps.reloadSuite(liveSuite.name)
                    } catch (compileErr) {
                        deps.onStepFailed?.({
                            index: i,
                            stepName: step.name,
                            error: `Reload failed: ${(compileErr as Error).message}`,
                            failureCategory: 'tool-crash',
                        })
                        continue
                    }
                    // Strict index-only: re-run whatever step is now at this index. If
                    // the edit removed it, there's nothing to retry — give up.
                    if (!liveSuite.steps[i]) {
                        stepFailureResolved = true
                        throw cause
                    }
                    // Drop the failed step's recorded rows so the retry re-occupies its
                    // position (keeps the GUI's positional step list aligned).
                    truncateEventsToPosition(events, positionAtStepStart)
                    recorder.dropFrom(positionAtStepStart)
                    deps.onRunState?.(buildRunState(events))
                    step = liveSuite.steps[i]
                }
            }
        }
    } catch (cause) {
        ok = false
        failureCategory = categorize(cause as Error)
        // Hold the browser open on failure (opt-in via onErrorHold; only the GUI
        // wires it). We're still inside the try/catch — the browser handle is open
        // and the finally's teardown has NOT run yet — so blocking here freezes the
        // failed state with a live, CDP-attachable browser for the run companion.
        // Release comes via the SAME resume/stop channel as a pause. Without the
        // hook this is a no-op and the finally tears down immediately, as before.
        //
        // Skip when a step failure already went through the retry channel and the
        // user chose to give up — it was already held once; don't hold again.
        if (deps.onErrorHold && !stepFailureResolved) {
            deps.onErrorHold({ failureCategory, error: (cause as Error).message })
            await deps.waitForResume?.()
        }
    } finally {
        // Guaranteed teardown: cleanup runs no matter how we got here.
        cleanupResult = await deps.runCleanup(cleanup).catch((e): RunResult['cleanup'] => ({
            ok: false,
            deleted: [],
            failed: ['cleanup-call-threw'],
            error: (e as Error).message,
        }))
        // Stop tracing into the bundle BEFORE closing the context.
        await handle?.saveTraceTo?.(recorder.bundleDir).catch(() => {})
        await handle?.close().catch(() => {})
        // Best-effort: the recorded video is only finalized after the context
        // closes, so persist it into the bundle now. A missing video never fails the run.
        await handle?.saveVideoTo?.(recorder.bundleDir).catch(() => {})
    }

    // A passing run whose cleanup failed is surfaced with the 'cleanup' category
    // (leftover test data may remain) without marking the test itself as failed.
    if (ok && !cleanupResult.ok) failureCategory = 'cleanup'

    const result = recorder.finish({ ok, failureCategory, cleanup: cleanupResult })
    // Final snapshot carrying the result (running=false) — the last write the
    // CLI persists to run-state.json.
    deps.onRunState?.(buildRunState(events, result))
    return result
}

// --- Production default deps ---

export function defaultDeps(vars: RunDeps['vars'] = process.env): RunDeps {
    const resultsRoot = resultsRootDir()
    return {
        vars,
        resultsRoot,
        openBrowser: async env => {
            const { launchChromeWithCdp } = await import('@/engine/cdp-launch')
            // channel:'chrome' + a remote-debugging port: drives the user's installed
            // Google Chrome (so the packaged app needs no browser download) AND lets
            // the run companion attach chrome-devtools-mcp to this same browser when
            // the run is idle.
            const { browser, context, page, cdpPort } = await launchChromeWithCdp({
                baseURL: env.baseURL,
                recordVideo: { dir: resultsRoot }, // moved into bundle after finish
            })
            // Capture a Playwright trace (DOM snapshots + screenshots + network +
            // console) so a tester can replay the whole run at trace.playwright.dev.
            // Best-effort: tracing must never fail the run.
            await context.tracing
                .start({ screenshots: true, snapshots: true, sources: true })
                .catch(() => {})
            const video = page.video()
            let browserClosed = false
            const closeBrowser = async () => {
                if (browserClosed) return
                browserClosed = true
                await browser.close().catch(() => {})
            }
            return {
                page,
                cookieHeader: '',
                cdpPort,
                // Stop tracing (writing trace.zip into the bundle) BEFORE the
                // context closes, then close the context — which finalizes the
                // video while keeping `video.saveAs()` usable. Browser closes in
                // saveVideoTo (or the fallback below).
                close: async () => {
                    await context.close().catch(() => {})
                },
                saveTraceTo: async (bundleDir: string) => {
                    // Stop tracing straight into the bundle. Must run BEFORE close().
                    await context.tracing
                        .stop({ path: path.join(bundleDir, 'trace.zip') })
                        .catch(() => {})
                },
                saveVideoTo: async (bundleDir: string) => {
                    // Persist the finalized video into the run bundle so
                    // report.html's <video src="video.webm"> resolves, then remove
                    // the orphan source so results/ doesn't accumulate junk. Runs
                    // after close() (context already closed → video is finalized).
                    try {
                        if (video) {
                            await video.saveAs(path.join(bundleDir, 'video.webm'))
                            await video.delete().catch(() => {})
                        }
                    } finally {
                        await closeBrowser()
                    }
                },
            }
        },
        login: async (handle, env, role, bundleDir) => loginAs(handle.page, env, role, bundleDir),
        runCleanup: async client => client.run(),
    }
}
