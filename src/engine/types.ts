// The role accounts each environment provides. Must match config + .env keys.
export type Role = 'admin' | 'researcher' | 'reviewer'

// Why these categories: a non-technical tester must be able to tell "the app has
// a bug" from "the tool/env is broken". See spec "Error handling & failure model".
export type FailureCategory =
    | 'app-assertion' // a real app bug — share the report
    | 'environment' // env down / 5xx / network — not a test failure
    | 'auth' // could not log in
    | 'cleanup' // run passed but cleanup failed — leftover data warning
    | 'tool-crash' // bug in the engine itself
    | 'ai-gave-up' // AI mode only: agent could not carry out the instruction

export type StepStatus = 'running' | 'passed' | 'failed'

export interface StepEvent {
    name: string
    status: StepStatus
    at: number // epoch ms
    screenshot?: string // path relative to the run bundle, set when captured
    error?: string
}

// Emitted once at run start when --screencast is active, telling the GUI which
// localhost WebSocket port to connect to for the live browser view.
export interface ScreencastInfo {
    port: number
}

// Emitted once by `qar session` when the long-lived authoring browser is ready:
// the CDP remote-debugging port (so chrome-devtools-mcp can attach via
// --browserUrl) and the screencast ws port (so the GUI shows the live view).
export interface SessionInfo {
    cdpPort: number
    screencastPort: number
}

export type RunMode = 'suite' | 'exploratory'

export interface RunRequest {
    suite: string // suite name, or the plain-English instruction in exploratory mode
    env: string // environment name, e.g. "qa" | "staging" (or a PR label like "pr839")
    role: Role
    mode?: RunMode // defaults to 'suite'
    // Pre-resolved environment. Used for ephemeral PR previews (resolvePrEnv),
    // where there is no named entry in the committed config. When set, the engine
    // uses it directly instead of resolving `env` by name.
    envConfig?: EnvConfig
}

export interface RunResult {
    ok: boolean
    failureCategory?: FailureCategory
    steps: StepEvent[]
    bundleDir: string // absolute path to the result bundle folder
    cleanup: { ok: boolean; deleted: string[]; failed: string[]; error?: string; statuses?: Record<string, number> }
    env: string
    role: Role
    mode: RunMode
    suite: string
    startedAt: number
    finishedAt: number
}

// Resolved, secret-filled environment config handed to a run.
export interface EnvConfig {
    name: string
    baseURL: string
    // Each account carries its own second-factor (MFA) code.
    accounts: Record<Role, { email: string; password: string; mfaCode: string }>
}
