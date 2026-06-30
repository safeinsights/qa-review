import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { suitesCompiledDir } from '@/engine/paths'
import type { Suite } from '@/suites/types'
import { signinSuite } from '@/suites/signin'
import { createStudySuite } from '@/suites/create-study'
import { discoverSuites } from '@/suites/discover'

const STATIC_SUITES: Suite[] = [signinSuite, createStudySuite]

// Discover any additional suites (e.g. AI-generated, pulled from git) by globbing
// the compiled-suites dir. `qar build-suites` writes <name>.mjs there from
// src/suites/*.ts — the bundled engine has no TS loader, so it imports the .mjs.
// The two built-in suites are statically imported above and excluded here.
async function discovered(): Promise<Suite[]> {
    const dir = suitesCompiledDir()
    if (!fs.existsSync(dir)) return []
    const exclude = new Set(['signin.mjs', 'create-study.mjs'])
    const files = fs
        .readdirSync(dir)
        .filter((f) => f.endsWith('.mjs') && !exclude.has(f))
        .map((f) => path.join(dir, f))
    // pathToFileURL so dynamic import works for absolute paths on all platforms.
    return discoverSuites(files, (f) => import(pathToFileURL(f).href))
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
