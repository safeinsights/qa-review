import type { ConsoleLine } from '@/engine/screencast-codec'

// One captured browser-console line (re-exported so run/recorder/GUI import it
// from types; defined in screencast-codec as the single source of truth).
export type { ConsoleLine } from '@/engine/screencast-codec'

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
    url?: string // the page's top-frame URL when the step resolved
    console?: ConsoleLine[] // console output emitted DURING this step
    error?: string
}

// Emitted once at run start when --screencast is active, telling the GUI which
// localhost WebSocket port to connect to for the live browser view.
export interface ScreencastInfo {
    port: number
    // The run browser's CDP remote-debugging port, so the run companion's
    // chrome-devtools-mcp can attach to the SAME browser (--browserUrl).
    cdpPort: number
}

// Emitted when the run halts before a step the user marked "pause before". The
// GUI reacts by showing the Paused banner + flipping Stop→Resume. The run stays
// blocked until a {type:'resume'} control message arrives on stdin.
export interface PausedInfo {
    name: string // the step the run is paused before
}

// Emitted when a run FAILS and the engine is holding the browser open so the run
// companion can inspect/drive the frozen failure state (via the run's CDP port).
// The GUI reacts by showing a "run failed — Claude can inspect the browser" banner
// and flipping Stop→Resume. The run stays blocked (browser alive) until a
// {type:'resume'} control message arrives on stdin, then teardown proceeds.
export interface ErrorHoldInfo {
    failureCategory?: FailureCategory
    error?: string
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

// A JSON snapshot of a run in progress OR finished, persisted to
// <bundleDir>/run-state.json so the run companion (Claude) can read it.
export interface RunState {
    // One entry per executed position, latest status (running collapsed into passed/failed).
    steps: StepEvent[]
    // Present once the run has finished.
    result?: RunResult
    // True while the run is still going (no result yet).
    running: boolean
}

// Resolved, secret-filled environment config handed to a run.
export interface EnvConfig {
    name: string
    baseURL: string
    // Each account carries its own second-factor (MFA) code and its own optional
    // results-decryption private key (only the study-happy-path suite needs the
    // key, so an unset value must NOT fail other runs).
    accounts: Record<Role, { email: string; password: string; mfaCode: string; privateKey?: string }>
}
