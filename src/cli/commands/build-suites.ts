import fs from 'node:fs'
import path from 'node:path'
import { build } from 'esbuild'
import { repoDir, suitesCompiledDir } from '@/engine/paths'

// Repo root for the SOURCE suites (src/suites/*.ts). In a source checkout this is
// the same as repoDir(); in the packaged app the engine bundle lives outside the
// clone, but the .ts suites it compiles live in the clone, so we anchor to repoDir().
function suitesSrcDir(): string {
    return path.join(repoDir(), 'src', 'suites')
}

// Infra files in src/suites that are NOT suites — never compile these.
const NON_SUITE = new Set(['types.ts', 'discover.ts'])

// The cloned repo's tsconfig.json carries the @/* -> src/* paths the suites import.
// It MUST come from the repo (where the .ts suites + their @/ deps live), not from
// the bundle's own location — in the packaged app the bundle sits outside the clone,
// so an import.meta.url-relative path would point inside the .app and not exist.
function repoTsconfig(): string | undefined {
    const p = path.join(repoDir(), 'tsconfig.json')
    return fs.existsSync(p) ? p : undefined
}

// The @/* paths, in case the repo has no tsconfig (defensive). Lets esbuild resolve
// the alias without a tsconfig file at all.
const ALIAS = { '@/*': ['src/*'], '@/gui/*': ['gui/frontend/src/*'] }

// Compile a single suite .ts (with its @/ imports + deps inlined) to a standalone
// .mjs the bundled engine can import() at runtime. Throws on a TS/build error.
export async function compileSuite(srcFile: string, outDir: string): Promise<string> {
    const name = path.basename(srcFile).replace(/\.ts$/, '')
    const outFile = path.join(outDir, `${name}.mjs`)
    fs.mkdirSync(outDir, { recursive: true })
    const tsconfig = repoTsconfig()
    await build({
        entryPoints: [srcFile],
        outfile: outFile,
        absWorkingDir: repoDir(), // resolve @/* and relative paths against the clone
        bundle: true,
        format: 'esm',
        platform: 'node',
        target: 'node20',
        ...(tsconfig
            ? { tsconfig }
            : { tsconfigRaw: { compilerOptions: { baseUrl: '.', paths: ALIAS } } }),
        // Playwright is provided by the engine's shipped node_modules, not inlined.
        external: ['@playwright/test', 'playwright', 'playwright-core'],
        logLevel: 'silent',
    })
    return outFile
}

// Compile every suite in src/suites/*.ts -> suites-compiled/*.mjs. Idempotent:
// clears stale outputs first so a removed/renamed source suite can't linger.
export async function buildSuites(): Promise<string[]> {
    const srcDir = suitesSrcDir()
    const outDir = suitesCompiledDir()
    if (fs.existsSync(outDir)) {
        for (const f of fs.readdirSync(outDir)) {
            if (f.endsWith('.mjs')) fs.rmSync(path.join(outDir, f), { force: true })
        }
    }
    if (!fs.existsSync(srcDir)) return []
    const sources = fs
        .readdirSync(srcDir)
        .filter((f) => f.endsWith('.ts') && !NON_SUITE.has(f))
        .map((f) => path.join(srcDir, f))
    const out: string[] = []
    for (const src of sources) out.push(await compileSuite(src, outDir))
    return out
}

export async function buildSuitesCommand(): Promise<void> {
    const out = await buildSuites()
    console.log(`Compiled ${out.length} suite(s) to ${suitesCompiledDir()}`)
}
