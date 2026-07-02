import type { Suite } from './types'

type Importer = (file: string) => Promise<Record<string, unknown>>

function isSuite(value: unknown): value is Suite {
    return (
        !!value &&
        typeof value === 'object' &&
        typeof (value as Suite).name === 'string' &&
        typeof (value as Suite).description === 'string' &&
        Array.isArray((value as Suite).roles) &&
        Array.isArray((value as Suite).steps) &&
        (value as Suite).steps.every(
            s => !!s && typeof s.name === 'string' && typeof s.run === 'function'
        )
    )
}

// Import each file and collect every export that matches the Suite shape.
// Pure of the filesystem: the caller supplies the file list + importer, so this
// is unit-testable and reusable for both real globbing and tests.
//
// A suite that throws on import (bad relative import, missing dep) must NOT hide
// every other suite — otherwise one broken file collapses the whole list. So each
// import is isolated: on failure we warn and skip that file, then keep going.
export async function discoverSuites(files: string[], importer: Importer): Promise<Suite[]> {
    const suites: Suite[] = []
    for (const file of files) {
        let mod: Record<string, unknown>
        try {
            mod = await importer(file)
        } catch (err) {
            // Intentional: a skipped suite must be visible (this went to stderr and
            // is folded into the run log), never silently dropped.
            // biome-ignore lint/suspicious/noConsole: surface skipped suites
            console.warn(`Skipping suite ${file}: ${err instanceof Error ? err.message : err}`)
            continue
        }
        for (const value of Object.values(mod)) {
            if (isSuite(value)) suites.push(value)
        }
    }
    return suites
}
