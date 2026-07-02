import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { discoverSuites } from '@/suites/discover'

// Compiles a .ts suite via the real `qar build-suites` machinery and confirms the
// emitted .mjs is loadable by the same dynamic-import the engine's suite-registry
// uses. This is the load-bearing path for the bundled (TS-loader-free) engine.

function makeTempRepo(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qar-suites-'))
    const suitesSrc = path.join(dir, 'src', 'suites')
    fs.mkdirSync(suitesSrc, { recursive: true })
    // A suite that imports the @/ alias — exercises tsconfig path resolution.
    fs.writeFileSync(
        path.join(suitesSrc, 'demo.ts'),
        [
            "import type { Suite } from '@/suites/types'",
            'export const demoSuite: Suite = {',
            "    name: 'demo', description: 'd', roles: ['admin'],",
            "    steps: [{ name: 'noop', run: async () => {} }],",
            '}',
            '',
        ].join('\n')
    )
    return dir
}

const created: string[] = []
afterEach(() => {
    for (const d of created.splice(0)) fs.rmSync(d, { recursive: true, force: true })
    delete process.env.QAR_REPO_DIR
})

describe('build-suites', () => {
    it('compiles src/suites/*.ts to suites-compiled/*.mjs and they are importable', async () => {
        const repo = makeTempRepo()
        created.push(repo)
        process.env.QAR_REPO_DIR = repo
        // Import after QAR_REPO_DIR is set so paths.ts resolves to the temp repo.
        // tsconfig anchoring still points at the real checkout for the @/ alias.
        const { buildSuites } = await import('@/cli/commands/build-suites')

        const out = await buildSuites()
        expect(out).toHaveLength(1)
        const mjs = path.join(repo, 'suites-compiled', 'demo.mjs')
        expect(fs.existsSync(mjs)).toBe(true)

        const suites = await discoverSuites([mjs], f => import(pathToFileURL(f).href))
        expect(suites.map(s => s.name)).toEqual(['demo'])
    }, 20000)

    it('recompiling an EDITED suite overwrites its .mjs with the new code (retry reload)', async () => {
        // The retry-reload path (run.ts reloadSuite) recompiles the suite from its
        // .ts source, then cache-bust re-imports the emitted .mjs. Assert the compile
        // half here: editing the source and recompiling to the SAME output path
        // overwrites it with the new code. (The cache-busting `import(url + '?t=N')`
        // half is exercised by the real runtime — vitest's loader ignores the query,
        // so it can't be asserted through import() here.)
        const repo = makeTempRepo()
        created.push(repo)
        process.env.QAR_REPO_DIR = repo
        const { compileSuite } = await import('@/cli/commands/build-suites')
        const src = path.join(repo, 'src', 'suites', 'demo.ts')
        const outDir = path.join(repo, 'suites-compiled')

        const mjs1 = await compileSuite(src, outDir)
        expect(fs.readFileSync(mjs1, 'utf8')).toContain('"noop"')

        // Edit the source: rename the step (the kind of fix a user makes on retry).
        fs.writeFileSync(
            src,
            [
                "import type { Suite } from '@/suites/types'",
                'export const demoSuite: Suite = {',
                "    name: 'demo', description: 'd', roles: ['admin'],",
                "    steps: [{ name: 'fixed', run: async () => {} }],",
                '}',
                '',
            ].join('\n')
        )
        const mjs2 = await compileSuite(src, outDir)
        expect(mjs2).toBe(mjs1) // same output path
        const out = fs.readFileSync(mjs2, 'utf8')
        expect(out).toContain('"fixed"')
        expect(out).not.toContain('"noop"')
    }, 20000)

    it('clears stale .mjs outputs for removed source suites', async () => {
        const repo = makeTempRepo()
        created.push(repo)
        process.env.QAR_REPO_DIR = repo
        const outDir = path.join(repo, 'suites-compiled')
        fs.mkdirSync(outDir, { recursive: true })
        fs.writeFileSync(path.join(outDir, 'gone.mjs'), 'export const x = 1')

        const { buildSuites } = await import('@/cli/commands/build-suites')
        await buildSuites()
        expect(fs.existsSync(path.join(outDir, 'gone.mjs'))).toBe(false)
        expect(fs.existsSync(path.join(outDir, 'demo.mjs'))).toBe(true)
    }, 20000)
})
