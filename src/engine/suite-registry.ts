import type { Suite } from '@/suites/types'
import { signinSuite } from '@/suites/signin'

const SUITES: Suite[] = [signinSuite]

export function listSuites(): { name: string; description: string }[] {
    return SUITES.map((s) => ({ name: s.name, description: s.description }))
}

export function getSuite(name: string): Suite {
    const suite = SUITES.find((s) => s.name === name)
    if (!suite) {
        const known = SUITES.map((s) => s.name).join(', ')
        throw new Error(`Unknown suite "${name}". Known suites: ${known}`)
    }
    return suite
}

export { SUITES }
