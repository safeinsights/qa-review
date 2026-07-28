import { chromium } from '@playwright/test'
import { loginAs } from '@/engine/auth'
import { resolveEnv, resolvePrEnv } from '@/engine/env'
import { type InvitedRole, ORG_FOR_ROLE, uniqueQaEmail } from '@/engine/flows/signup'
import { QaApiClient } from '@/engine/qa-api'
import type { Vars } from '@/engine/settings'

// `qar invite [--role researcher|reviewer | --org <slug>] [--email <addr>] [--admin]`
//
// Mint an invite through the QA API and print `{"inviteUrl","email",…}` — no inbox, no
// waiting on delivery. The invited role is implied by the ORG, so --role is just a
// shorthand for the org that grants it.
//
// Note the signup SUITE deliberately does NOT use this: it drives the real invite UI
// and reads the real email, because that end-to-end flow is what it exists to test.
export async function inviteCommand(opts: Record<string, string>, vars: Vars): Promise<void> {
    const role = opts.role as InvitedRole | undefined
    if (role && !(role in ORG_FOR_ROLE)) {
        throw new Error(
            `--role must be one of ${Object.keys(ORG_FOR_ROLE).join(', ')} (got "${opts.role}")`
        )
    }
    const orgSlug = opts.org ?? (role ? ORG_FOR_ROLE[role] : '')
    if (!orgSlug) throw new Error('invite requires --role <researcher|reviewer> or --org <slug>')

    // A generated address must start with "qa" or the server refuses it (assertQaEmail).
    const email = opts.email ?? uniqueQaEmail()
    const env = opts.pr ? resolvePrEnv(Number(opts.pr), vars) : resolveEnv(opts.env ?? 'qa', vars)

    // The endpoint authorizes with an SI-admin Clerk session JWT, which loginAs returns.
    const browser = await chromium.launch({ channel: 'chrome' })
    const context = await browser.newContext({ baseURL: env.baseURL })
    const page = await context.newPage()
    let token: string
    try {
        token = await loginAs(page, env, 'admin')
    } finally {
        await context.close()
        await browser.close()
    }
    if (!token) {
        throw new Error('could not read an admin Clerk session token — cannot call the QA API')
    }

    const api = new QaApiClient(env.baseURL, token)
    const result = await api.createInvite({
        email,
        orgSlug,
        isAdmin: opts.admin === 'true',
    })
    process.stdout.write(`${JSON.stringify(result)}\n`)
}
