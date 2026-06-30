// Bundles the qar CLI engine (bin/qar.ts + all @/ source) into a single ESM file
// the packaged desktop app runs with a shipped node, so staff need no
// Node/pnpm/tsx to run a suite. Run before `wails build` so the bundle is staged
// into the .app's Contents/Resources.
//
//   node esbuild.config.mjs            # build the engine bundle
//
import { build } from 'esbuild'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(fileURLToPath(import.meta.url))
const outfile = path.join(root, 'gui', 'build', 'engine', 'qar.bundle.mjs')

await build({
    entryPoints: [path.join(root, 'bin', 'qar.ts')],
    outfile,
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node20',
    // Resolves the tsconfig `paths` (@/* -> src/*, @/gui/* -> gui/frontend/src/*).
    tsconfig: path.join(root, 'tsconfig.json'),
    // Playwright is shipped as node_modules alongside the bundle (Phase 4) and
    // resolved at runtime via NODE_PATH — never inline its driver/binaries.
    // esbuild itself stays external too: its platform binary can't be bundled, and
    // build-suites/codegen load it from the shipped node_modules.
    external: ['@playwright/test', 'playwright', 'playwright-core', 'esbuild'],
    // Bundled CommonJS deps (e.g. ws) call require() for Node built-ins. In an ESM
    // output esbuild stubs require() to throw, so inject a real one via
    // createRequire. import.meta.url path anchoring stays intact.
    banner: {
        js: [
            "import { createRequire as __cr } from 'node:module';",
            'const require = __cr(import.meta.url);',
        ].join('\n'),
    },
    logLevel: 'info',
})

console.log(`engine bundle written: ${path.relative(root, outfile)}`)
