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

// Suite source dir. The engine imports these .ts files directly via tsx (both
// `pnpm qar` and the packaged app run node with `--import tsx`), so there is no
// compile step — the registry globs this dir.
export function suitesSrcDir(): string {
    return path.join(repoDir(), 'src', 'suites')
}
