import type { Page } from '@playwright/test'
import type { Role, StepStatus } from '@/engine/types'

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
}

export interface Suite {
    name: string
    description: string
    roles: Role[] // which role(s) this suite is meant to run as
    run(ctx: RunContext): Promise<void>
}

export type StepReporter = (name: string, status: StepStatus, extra?: { error?: string }) => void
