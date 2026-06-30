import type { Role } from '@/engine/types'

export type Action =
    | { step: string; kind: 'goto'; url: string }
    | { step: string; kind: 'click'; selector: string }
    | { step: string; kind: 'fill'; selector: string; value: string }
    | { step: string; kind: 'expectVisible'; selector: string }

export interface ActionTrace {
    name: string
    description: string
    role: Role
    actions: Action[]
}

const KINDS = new Set(['goto', 'click', 'fill', 'expectVisible'])

export function parseTrace(raw: string): ActionTrace {
    const obj = JSON.parse(raw) as ActionTrace
    for (const a of obj.actions) {
        if (!KINDS.has(a.kind)) throw new Error(`Unknown action kind "${a.kind}"`)
    }
    return obj
}
