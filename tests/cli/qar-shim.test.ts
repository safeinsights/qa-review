import { execFile } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'

const execFileAsync = promisify(execFile)
const SHIM = resolve(__dirname, '../../bin/qar')

// Run the shim with a controlled env. PATH is trimmed to a pnpm-free set so the
// dev fallback can be observed as a "pnpm not available" exit rather than actually
// booting the engine (which would be slow and would touch the real settings).
async function runShim(env: Record<string, string>) {
    try {
        const { stdout, stderr } = await execFileAsync(SHIM, ['list'], {
            env: { PATH: '/usr/bin:/bin', ...env },
        })
        return { code: 0, stdout, stderr }
    } catch (e) {
        const err = e as { code?: number; stdout?: string; stderr?: string }
        return { code: err.code ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' }
    }
}

// Single-quote a value for the generated script: call sites pass literals today,
// but a computed one would otherwise be shell, not data.
function shellQuote(value: string) {
    return `'${value.replaceAll("'", `'\\''`)}'`
}

// Shell expansion, assembled rather than written literally so biome does not read
// it as a JS template placeholder (lint/suspicious/noTemplateCurlyInString).
const PROXY_ENV = ['$', '{NODE_USE_ENV_PROXY:-unset}'].join('')

// A stand-in for a node binary. Reports `-v` as `version`, and for any other
// argv prints `marker` plus the NODE_USE_ENV_PROXY it was handed — so a test can
// tell which node the shim chose AND whether it asked for env-proxy support.
function fakeNode(version: string, marker: string) {
    const dir = mkdtempSync(join(tmpdir(), 'qar-fakenode-'))
    writeFileSync(
        join(dir, 'node'),
        [
            '#!/usr/bin/env bash',
            `version=${shellQuote(version)}`,
            `marker=${shellQuote(marker)}`,
            'if [ "$1" = "-v" ]; then printf \'%s\\n\' "$version"; exit 0; fi',
            `printf '%s proxy=%s\\n' "$marker" "${PROXY_ENV}"`,
            '',
        ].join('\n'),
        { mode: 0o755 }
    )
    return join(dir, 'node')
}

// An executable node that answers `-v` with nothing usable — a damaged or
// wrong-arch copy. The shim's existence and executable checks both pass for it, so
// only the version probe can catch it.
function unversionedNode(marker: string) {
    const dir = mkdtempSync(join(tmpdir(), 'qar-badnode-'))
    writeFileSync(
        join(dir, 'node'),
        [
            '#!/usr/bin/env bash',
            `marker=${shellQuote(marker)}`,
            'if [ "$1" = "-v" ]; then exit 1; fi',
            `printf '%s proxy=%s\\n' "$marker" "${PROXY_ENV}"`,
            '',
        ].join('\n'),
        { mode: 0o755 }
    )
    return join(dir, 'node')
}

// The packaged contract's other half. Contents are never read — the shim only
// checks that the file exists — but a fake node echoes nothing without it.
function fakeBundle() {
    const dir = mkdtempSync(join(tmpdir(), 'qar-bundle-'))
    const bundle = join(dir, 'qar.bundle.mjs')
    writeFileSync(bundle, '')
    return bundle
}

const PROXY = 'http://localhost:49629'

// A directory that looks like a dev checkout to the shim: the engine SOURCE is what
// distinguishes a checkout from a packaged app's Resources dir.
function fakeCheckout() {
    const dir = mkdtempSync(join(tmpdir(), 'qar-checkout-'))
    mkdirSync(join(dir, 'bin'))
    writeFileSync(join(dir, 'bin', 'qar.ts'), '// engine source\n')
    return dir
}

describe('bin/qar shim', () => {
    // The regression: scripts/approve-access.sh sets QAR_REPO_DIR="$REPO" to target a
    // clone, and the shim used to read that alone as "packaged app with a lost bundle"
    // and exit 127 — breaking approve-access.sh in an ordinary dev checkout.
    it('treats QAR_REPO_DIR pointing at a checkout as dev, not a broken install', async () => {
        const r = await runShim({ QAR_REPO_DIR: fakeCheckout() })
        expect(r.stderr).not.toContain('broken packaged install')
    })

    it('still reports a broken packaged install when the repo dir is not a checkout', async () => {
        const notACheckout = mkdtempSync(join(tmpdir(), 'qar-notcheckout-'))
        const r = await runShim({ QAR_REPO_DIR: notACheckout })
        expect(r.code).toBe(127)
        expect(r.stderr).toContain('broken packaged install')
    })

    // Both halves of the packaged contract must be present; QAR_NODE alone pointing at
    // a nonexistent file is a broken bundle, not a reason to fall back to pnpm.
    it('reports missing bundle files when QAR_NODE/QAR_BUNDLE do not exist', async () => {
        const r = await runShim({
            QAR_NODE: '/nonexistent/node',
            QAR_BUNDLE: '/nonexistent/qar.bundle.mjs',
        })
        expect(r.code).toBe(127)
        expect(r.stderr).toContain('missing files from the app bundle')
    })
    // The sandbox regression this whole block exists for: the app's pinned node
    // predates NODE_USE_ENV_PROXY (Node 24+), so under a proxy every outbound qar
    // command died with a bare `fetch failed` that named neither node nor a host.
    describe('under a network proxy', () => {
        it('prefers a Node 24+ from PATH over a pinned node too old to proxy', async () => {
            const pinned = fakeNode('v22.14.0', 'PINNED')
            const onPath = fakeNode('v24.18.0', 'FROM-PATH')
            const r = await runShim({
                PATH: `${dirname(onPath)}:/usr/bin:/bin`,
                QAR_NODE: pinned,
                QAR_BUNDLE: fakeBundle(),
                HTTPS_PROXY: PROXY,
            })
            expect(r.stdout).toContain('FROM-PATH')
            expect(r.stdout).not.toContain('PINNED')
        })

        it('asks the chosen node for env-proxy support', async () => {
            const onPath = fakeNode('v24.18.0', 'FROM-PATH')
            const r = await runShim({
                PATH: `${dirname(onPath)}:/usr/bin:/bin`,
                QAR_NODE: fakeNode('v22.14.0', 'PINNED'),
                QAR_BUNDLE: fakeBundle(),
                HTTPS_PROXY: PROXY,
            })
            expect(r.stdout).toContain('proxy=1')
        })

        // Falling back silently would reproduce the original bug: the command runs,
        // then fails deep inside undici with an error naming nothing.
        it('names the cause when no proxy-capable node can be found', async () => {
            const pinned = fakeNode('v22.14.0', 'PINNED')
            const r = await runShim({
                PATH: '/usr/bin:/bin',
                QAR_NODE: pinned,
                QAR_BUNDLE: fakeBundle(),
                HTTPS_PROXY: PROXY,
            })
            expect(r.stderr).toContain('NODE_USE_ENV_PROXY needs 24+')
            expect(r.stdout).toContain('PINNED')
        })

        it('uses the pin when it is already new enough, without searching PATH', async () => {
            const onPath = fakeNode('v24.18.0', 'FROM-PATH')
            const r = await runShim({
                PATH: `${dirname(onPath)}:/usr/bin:/bin`,
                QAR_NODE: fakeNode('v24.0.0', 'PINNED'),
                QAR_BUNDLE: fakeBundle(),
                HTTPS_PROXY: PROXY,
            })
            expect(r.stdout).toContain('PINNED')
            expect(r.stdout).toContain('proxy=1')
        })
    })

    // The pin exists so the .app does not depend on the user's toolchain. Overriding
    // it whenever a newer node happens to be installed would trade a narrow sandbox
    // bug for a broad one, so the substitution must be gated on the proxy alone.
    it('leaves the pinned node alone when no proxy is configured', async () => {
        const onPath = fakeNode('v24.18.0', 'FROM-PATH')
        const r = await runShim({
            PATH: `${dirname(onPath)}:/usr/bin:/bin`,
            QAR_NODE: fakeNode('v22.14.0', 'PINNED'),
            QAR_BUNDLE: fakeBundle(),
        })
        expect(r.stdout).toContain('PINNED')
        expect(r.stdout).toContain('proxy=unset')
    })

    // Distinct from "the pin is old": an unreadable version is a damaged bundle, and
    // saying nothing would silently swap the pin out — the same unnamed-failure shape
    // this whole block exists to remove.
    it('reports a pinned node that cannot state its version', async () => {
        const onPath = fakeNode('v24.18.0', 'FROM-PATH')
        const r = await runShim({
            PATH: `${dirname(onPath)}:/usr/bin:/bin`,
            QAR_NODE: unversionedNode('PINNED'),
            QAR_BUNDLE: fakeBundle(),
            HTTPS_PROXY: PROXY,
        })
        expect(r.stderr).toContain('did not report a version')
    })
})
