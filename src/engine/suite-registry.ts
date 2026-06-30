import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Suite } from '@/suites/types'
import { signinSuite } from '@/suites/signin'
import { createStudySuite } from '@/suites/create-study'
import { discoverSuites } from '@/suites/discover'

const STATIC_SUITES: Suite[] = [signinSuite, createStudySuite]

// Discover any additional suites (e.g. AI-generated, pulled from git) by globbing
// the suites dir, excluding infra files and the ones already imported statically.
async function discovered(): Promise<Suite[]> {
    const dir = path.dirname(fileURLToPath(new URL('../suites/types.ts', import.meta.url)))
    const exclude = new Set(['types.ts', 'discover.ts', 'signin.ts', 'create-study.ts'])
    const files = fs
        .readdirSync(dir)
        .filter((f) => f.endsWith('.ts') && !exclude.has(f))
        .map((f) => path.join(dir, f))
    return discoverSuites(files, (f) => import(f))
}

let cache: Suite[] | null = null
async function allSuites(): Promise<Suite[]> {
    if (cache) return cache
    cache = [...STATIC_SUITES, ...(await discovered())]
    return cache
}

export async function listSuites(): Promise<{ name: string; description: string }[]> {
    return (await allSuites()).map((s) => ({ name: s.name, description: s.description }))
}

export async function getSuite(name: string): Promise<Suite> {
    const suite = (await allSuites()).find((s) => s.name === name)
    if (!suite) {
        const known = (await allSuites()).map((s) => s.name).join(', ')
        throw new Error(`Unknown suite "${name}". Known suites: ${known}`)
    }
    return suite
}

export { allSuites as SUITES }
