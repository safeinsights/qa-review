import type { Page } from '@playwright/test'
import type { Role, StepStatus } from '../engine/types'

export interface RunContext {
    page: Page
    baseURL: string
    // Unique-per-run suffix for any titles the suite creates (human-readable +
    // collision-free), mirroring management-app's uniqueTitle pattern.
    tag: string
    // Emit a step event. Wrap an action: await step('Create study', () => ...).
    step<T>(name: string, action: () => Promise<T>): Promise<T>
    // Register ids for guaranteed id-based cleanup (Task 5).
    trackStudy(id: string): void
    trackUser(id: string): void
    // Switch the live browser to a different shared account mid-run. Clears the
    // Playwright context (cookies + web storage), re-drives Clerk as `role`, and
    // re-points the cleanup client's auth cookie so id-based cleanup keeps
    // working as the newly-signed-in user. Used by multi-role suites (e.g. a
    // researcher submits, then a reviewer approves).
    loginAs(role: Role): Promise<void>
    // The reviewer's results-decryption private key, when configured (secret var
    // REVIEWER_RESULTS_PRIVATE_KEY). Undefined if unset — a suite that needs it
    // should throw a clear error pointing at `qar set-secret`.
    resultsKey?: string
    // Per-run mutable scratch bag. Steps are separate objects now (see Step), so a
    // value one step captures (e.g. a created study's id) is stashed here for a
    // later step to read: `ctx.state.studyId = id` … `ctx.state.studyId as string`.
    state: Record<string, unknown>
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
