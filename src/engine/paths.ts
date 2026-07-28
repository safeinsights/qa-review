import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Single source of truth for "where is the cloned qa-review repo". The packaged
// desktop app spawns the bundled engine with QAR_REPO_DIR set to the user-writable
// clone (e.g. ~/Library/Application Support/qa-runner/repo). When the var is
// absent — i.e. running `pnpm qar` from a source checkout — we locate the repo
// root by walking UP from this module until we find the package.json.
//
// We can't hard-code a fixed "../.." offset: this module is imported both from
// src/engine/ (source, via tsx) AND, in the packaged app, from the esbuild-bundled
// qar.bundle.mjs under Contents/Resources/ — a different depth entirely. Walking up
// to package.json is correct from source; in the packaged app QAR_REPO_DIR wins
// (the bundle location has no package.json).
export function repoDir(): string {
    const override = process.env.QAR_REPO_DIR
    if (override) return override
    let dir = path.dirname(fileURLToPath(import.meta.url))
    while (true) {
        if (fs.existsSync(path.join(dir, 'package.json'))) return dir
        const parent = path.dirname(dir)
        if (parent === dir) break // reached the filesystem root
        dir = parent
    }
    // Fallback to the historical assumption (src/engine -> repo root) if no
    // package.json was found, so behavior never regresses to a throw.
    return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
}

// config/ holds settings.json, settings.secrets.json, settings.local.json,
// keyring.json, keyring.lock, and the per-user age-identity.txt.
export function configDir(): string {
    return path.join(repoDir(), 'config')
}

// Where run bundles (screencast, trace, report) are written.
export function resultsRoot(): string {
    return path.join(repoDir(), 'results')
}

// The live run-state JSON the run companion reads. One filename, one place.
export function runStatePath(bundleDir: string): string {
    return path.join(bundleDir, 'run-state.json')
}

// On-demand action rendezvous for a live `qar session`. A sibling `qar session-*`
// command writes a request here; the running session process watches this path,
// performs the action on its held browser, and writes the outcome to
// sessionRequestResultPath(). One session at a time, so a single fixed path needs
// no per-run coordination. `session-login`, `session-create-user`, and
// `session-create-study` all share this one channel (each request carries an
// `action` field).
export function sessionRequestPath(): string {
    return path.join(resultsRoot(), 'session-request.json')
}

export function sessionRequestResultPath(): string {
    return path.join(resultsRoot(), 'session-request-result.json')
}

// Rendezvous for "a verdict was posted to Jira". `qar verdict-posted` writes
// `{ issue, result }` here after Claude posts a validated/rejected verdict (whether
// driven by the GUI's Verdict button or a manual instruction); the running validation
// session polls this path and tells the GUI, which then hides the Verdict button and
// shows the outcome. One session at a time, so a single fixed path needs no keying.
export function verdictPostedPath(): string {
    return path.join(resultsRoot(), 'verdict-posted.json')
}

// Single-instance lock for `qar session`. The rendezvous above is ONE fixed path,
// so a second session would consume requests meant for the first: `session-login`
// would report success while logging in a browser nobody is attached to. The lock
// holds the owner's pid so a stale file (killed process) can be distinguished from
// a live owner and reclaimed.
export function sessionLockPath(): string {
    return path.join(resultsRoot(), 'session.lock')
}

// Suite source dir. The engine imports these .ts files directly via tsx (both
// `pnpm qar` and the packaged app run node with `--import tsx`), so there is no
// compile step — the registry globs this dir.
export function suitesSrcDir(): string {
    return path.join(repoDir(), 'src', 'suites')
}
