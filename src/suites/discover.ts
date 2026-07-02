import type { Suite } from '@/suites/types'

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
export async function discoverSuites(files: string[], importer: Importer): Promise<Suite[]> {
    const suites: Suite[] = []
    for (const file of files) {
        const mod = await importer(file)
        for (const value of Object.values(mod)) {
            if (isSuite(value)) suites.push(value)
        }
    }
    return suites
}
