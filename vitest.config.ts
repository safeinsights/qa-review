import path from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
    resolve: {
        alias: {
            '@/gui': path.resolve(__dirname, 'gui/frontend/src'),
            '@': path.resolve(__dirname, 'src'),
        },
    },
    test: {
        // Engine unit tests only — Playwright suites run via the CLI, not vitest.
        include: ['tests/**/*.test.ts'],
        environment: 'node',
        // A few tests shell out to a real `pnpm typecheck` to prove generated code
        // actually compiles (tests/codegen). That's a full tsc over the project —
        // ~1.5s idle, but well past vitest's 5s default when it competes with the
        // other files running in parallel, which made those tests flaky. The work is
        // genuinely slow, so raise the ceiling rather than make the assertion weaker.
        testTimeout: 30_000,
    },
})
