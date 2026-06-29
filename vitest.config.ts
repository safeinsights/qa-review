import { defineConfig } from 'vitest/config'
import path from 'node:path'

export default defineConfig({
    resolve: {
        alias: { '@': path.resolve(__dirname, 'src') },
    },
    test: {
        // Engine unit tests only — Playwright suites run via the CLI, not vitest.
        include: ['tests/**/*.test.ts'],
        environment: 'node',
    },
})
