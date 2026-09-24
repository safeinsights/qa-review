import type { Page } from '@playwright/test'
import type { Role, StepStatus } from '../engine/types'

export interface RunContext {
    // The live browser page — guarded, not raw. Read it inside your step body and use
    // it normally; if the step's deadline fires, every action through this page (and
    // through any locator reached from it) throws StepAbandonedError instead of
    // driving a browser the retry has since taken over. Nothing to opt into.
    page: Page
    baseURL: string
    // The run browser's CDP remote-debugging port. Lighthouse (and anything else
    // that speaks CDP rather than Playwright) attaches by port number, so this is
    // how a suite audits the SAME already-authenticated browser the steps drive.
    // Optional because the headed path (engine/run-headed.ts) launches without a
    // debugging port — a suite that needs it must say so with a clear error.
    readonly cdpPort?: number
    // This run's result bundle on disk (the dir holding screenshots/, trace.zip,
    // video.webm). A suite writes its own artifacts here — e.g. the lighthouse
    // suite's HTML reports — so they land beside the rest of the run's evidence.
    readonly bundleDir: string
    // Unique-per-run suffix for any titles the suite creates (human-readable +
    // collision-free), mirroring management-app's uniqueTitle pattern.
    tag: string
    // Emit a step event. Wrap an action: await step('Create study', () => ...).
    // Omit the name to record under the ENCLOSING step's own `name` (the common
    // case — a 1:1 step: `run: ctx => ctx.step(() => doThing(ctx))`). Pass a name
    // only to split a body into multiple named positions or to use a sub-label
    // that differs from the step's `name`.
    step<T>(action: () => Promise<T>): Promise<T>
    step<T>(name: string, action: () => Promise<T>): Promise<T>
    // Attach numeric results to the ENCLOSING ctx.step()'s event, so they ride
    // along with its screenshot/url/console and show next to its row in the GUI.
    // Call it from inside the step body; the engine folds the values into the
    // 'passed'/'failed' event it records when the body resolves.
    recordMetrics(metrics: Record<string, number>): void
    // Register ids for guaranteed id-based cleanup (Task 5).
    trackStudy(id: string): void
    trackUser(id: string): void
    // Switch the live browser to a different shared account mid-run. Clears the
    // Playwright context (cookies + web storage), re-drives Clerk as `role`, and
    // re-points the cleanup client's auth cookie so id-based cleanup keeps
    // working as the newly-signed-in user. Used by multi-role suites (e.g. a
    // researcher submits, then a reviewer approves).
    loginAs(role: Role): Promise<void>
    // The CURRENTLY signed-in role's results-decryption private key, tracking loginAs()
    // exactly as `account` below does (secret var `<ROLE>_RESULTS_PRIVATE_KEY_<ENV>`).
    // Per-role because reviewers and researchers decrypt with DIFFERENT keys — the
    // reviewer opens the returned results, the researcher opens the outputs the reviewer
    // shared back (OTTER-688). Undefined if unset — a suite that needs it should throw a
    // clear error pointing at `qar set-secret`.
    resultsKey?: string
    // The CURRENTLY signed-in role, tracking loginAs() like the two values around it.
    // Use it to NAME the role in a message about a per-role value (`resultsKey`,
    // `account`) rather than hardcoding one — a hardcoded role reads correctly until a
    // second role reaches the same helper, and then it points at the wrong account.
    role: Role
    // Credentials for the CURRENTLY signed-in role, tracking loginAs(). A suite
    // needs these when it has to drive a login form the engine's own loginAs()
    // doesn't cover — e.g. the Coder IDE's Clerk-hosted OIDC sign-in, which forces
    // a fresh interactive login (prompt=login) outside the app.
    account: { email: string; password: string; mfaCode: string }
    // Per-run mutable scratch bag. Steps are separate objects now (see Step), so a
    // value one step captures (e.g. a created study's id) is stashed here for a
    // later step to read: `ctx.state.studyId = id` … `ctx.state.studyId as string`.
    state: Record<string, unknown>
    // False while this attempt is the live one; true once its step deadline fired and
    // the engine moved on. Checking this is OPTIONAL — `page` above already refuses to
    // act for an abandoned attempt. Use it when a long loop should exit quietly rather
    // than by throwing StepAbandonedError on its next page action.
    readonly signal: { readonly aborted: boolean }
}

// One named step in a suite. The engine loops over `Suite.steps` and calls each
// `run(ctx)` in order, so a suite's step names are statically enumerable (used to
// show the plan before a run) WITHOUT executing anything. Wrap the actual work in
// `ctx.step(name, action)` inside `run` so the status/screenshot/error machinery
// still fires.
export interface Step {
    name: string
    run(ctx: RunContext): Promise<void>
}

export interface Suite {
    name: string
    description: string
    roles: Role[] // which role(s) this suite is meant to run as
    steps: Step[] // ordered; the single source of truth for this suite's step names
}

export type StepReporter = (name: string, status: StepStatus, extra?: { error?: string }) => void
