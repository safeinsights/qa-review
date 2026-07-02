import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { suitesSrcDir } from '@/engine/paths'
import { discoverSuites } from '@/suites/discover'
import type { Suite } from '@/suites/types'

// Not suites — shared helpers that happen to live alongside the suites.
const NON_SUITE = new Set(['types.ts', 'discover.ts'])

// Discover all suites by globbing src/suites/*.ts and importing each directly.
// The engine runs under tsx (`--import tsx` in both dev and the packaged app), so
// there is no compile step — the .ts is the runtime artifact.
async function discovered(): Promise<Suite[]> {
    const dir = suitesSrcDir()
    if (!fs.existsSync(dir)) return []
    const files = fs
        .readdirSync(dir)
        .filter(f => f.endsWith('.ts') && !NON_SUITE.has(f))
        .map(f => path.join(dir, f))
    // pathToFileURL so dynamic import works for absolute paths on all platforms.
    return discoverSuites(files, f => import(pathToFileURL(f).href))
}

let cache: Suite[] | null = null
async function allSuites(): Promise<Suite[]> {
    if (cache) return cache
    cache = await discovered()
    return cache
}

export async function listSuites(): Promise<
    { name: string; description: string; roles: string[]; steps: string[] }[]
> {
    return (await allSuites()).map(s => ({
        name: s.name,
        description: s.description,
        roles: s.roles,
        // Static step names — the GUI shows these before a run (no execution needed).
        steps: s.steps.map(st => st.name),
    }))
}

export async function getSuite(name: string): Promise<Suite> {
    const all = await allSuites()
    const suite = all.find(s => s.name === name)
    if (!suite) {
        throw new Error(`Unknown suite "${name}". Known suites: ${all.map(s => s.name).join(', ')}`)
    }
    return suite
}
