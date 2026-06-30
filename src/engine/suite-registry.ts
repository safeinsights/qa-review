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

export async function listSuites(): Promise<{ name: string; description: string; roles: string[] }[]> {
    return (await allSuites()).map((s) => ({ name: s.name, description: s.description, roles: s.roles }))
}

export async function getSuite(name: string): Promise<Suite> {
    const all = await allSuites()
    const suite = all.find((s) => s.name === name)
    if (!suite) {
        throw new Error(`Unknown suite "${name}". Known suites: ${all.map((s) => s.name).join(', ')}`)
    }
    return suite
}
