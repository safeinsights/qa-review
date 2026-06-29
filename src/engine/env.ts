import { ENVIRONMENTS } from '../../config/environments'
import type { EnvConfig, Role } from '@/engine/types'

type Vars = Record<string, string | undefined>

function read(vars: Vars, key: string): string {
    const value = vars[key]
    if (!value) throw new Error(`Missing required secret: ${key} (set it in .env)`)
    return value
}

// Merge the committed declaration (config/environments.ts) with secret values
// from `vars` (defaults to process.env). Throws clear, actionable errors so a QA
// run never starts half-configured.
export function resolveEnv(name: string, vars: Vars = process.env): EnvConfig {
    const decl = ENVIRONMENTS.find((e) => e.name === name)
    if (!decl) {
        const known = ENVIRONMENTS.map((e) => e.name).join(', ')
        throw new Error(`Unknown environment "${name}". Known environments: ${known}`)
    }
    const roles: Role[] = ['admin', 'researcher', 'reviewer']
    const accounts = {} as EnvConfig['accounts']
    for (const role of roles) {
        const a = decl.accounts[role]
        accounts[role] = { email: read(vars, a.emailVar), password: read(vars, a.passwordVar) }
    }
    return { name: decl.name, baseURL: read(vars, decl.baseUrlVar), accounts }
}
