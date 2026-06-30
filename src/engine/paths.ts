import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Single source of truth for "where is the cloned qa-review repo". The packaged
// desktop app spawns the bundled engine with QAR_REPO_DIR set to the user-writable
// clone (e.g. ~/Library/Application Support/qa-runner/repo). When the var is
// absent — i.e. running `pnpm qar` from a source checkout — we fall back to this
// module's own location (src/engine -> ../.. is the repo root), so dev keeps
// working unchanged.
export function repoDir(): string {
    const override = process.env.QAR_REPO_DIR
    if (override) return override
    const here = path.dirname(fileURLToPath(import.meta.url))
    return path.resolve(here, '../..')
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

// Compiled suites the bundled engine imports at runtime. `qar build-suites`
// writes <name>.mjs here from src/suites/*.ts; the registry globs this dir.
export function suitesCompiledDir(): string {
    return path.join(repoDir(), 'suites-compiled')
}
