import { chromium } from '@playwright/test'
import { loginAs } from '@/engine/auth'
import { resolveEnv, resolvePrEnv } from '@/engine/env'
import type { Vars } from '@/engine/settings'
import type { Role } from '@/engine/types'

// Authenticate as a role and print the session cookie header on stdout, so the
// qa-explore skill can reuse the engine's deterministic Clerk+MFA login instead
// of re-implementing it. Prints ONLY the cookie line (callers capture stdout).
export async function loginCommand(opts: Record<string, string>, vars: Vars): Promise<void> {
    const role = (opts.role ?? 'admin') as Role
    const env = opts.pr ? resolvePrEnv(Number(opts.pr), vars) : resolveEnv(opts.env ?? 'qa', vars)

    const browser = await chromium.launch({ channel: 'chrome' })
    const context = await browser.newContext({ baseURL: env.baseURL })
    const page = await context.newPage()
    try {
        const cookie = await loginAs(page, env, role)
        process.stdout.write(`${cookie}\n`)
    } finally {
        await context.close()
        await browser.close()
    }
}
