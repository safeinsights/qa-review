import { createInterface } from 'node:readline/promises'
import { chromium } from '@playwright/test'
import { loginAs } from '@/engine/auth'
import { resolveEnv, resolvePrEnv } from '@/engine/env'
import { publicKeyFromPrivatePem } from '@/engine/public-key'
import { QaApiClient, type QaUserUpdate } from '@/engine/qa-api'
import type { Vars } from '@/engine/settings'
import type { Role } from '@/engine/types'
import { privateKeyEnvFor, privateKeyVar, SHARED_ACCOUNTS } from '../../../config/environments'

const ROLES: Role[] = ['admin', 'researcher', 'reviewer']

// Ask before writing. These endpoints overwrite a real password and can rotate the
// results key — which orphans anything already wrapped to the old one — so a typo in
// --role or --env should not be silently destructive.
async function confirm(prompt: string): Promise<boolean> {
    const rl = createInterface({ input: process.stdin, output: process.stderr })
    try {
        const answer = await rl.question(prompt)
        return /^y(es)?$/i.test(answer.trim())
    } finally {
        rl.close()
    }
}

// `qar fix-account --role <r> [--env <e> | --pr <n>] [--password] [--key] [--yes]`
//
// Reconcile a shared test account with what settings say about it: push the password
// and/or the PUBLIC half of the stored results private key onto the account. This is
// the drift fix — when the app's stored public key and our private key disagree,
// results get wrapped to a key we cannot unwrap.
//
// With neither --password nor --key, BOTH are pushed. Org memberships are never
// touched (omitted fields are left alone server-side), so this can't reshuffle a
// shared account's orgs by accident.
export async function fixAccountCommand(opts: Record<string, string>, vars: Vars): Promise<void> {
    const role = opts.role as Role
    if (!ROLES.includes(role)) {
        throw new Error(`--role must be one of ${ROLES.join(', ')} (got "${opts.role ?? ''}")`)
    }
    // Resolves ALL roles, deliberately: besides the role being fixed, this command
    // signs in as `admin` further down to get the Clerk session JWT the QA API
    // authorizes with, so an unconfigured admin really is a blocker here.
    const env = opts.pr ? resolvePrEnv(Number(opts.pr), vars) : resolveEnv(opts.env ?? 'qa', vars)
    const account = env.accounts[role]

    // Which fields to push. Naming neither means both.
    const wantPassword = opts.password === 'true' || opts.key !== 'true'
    const wantKey = opts.key === 'true' || opts.password !== 'true'

    const update: QaUserUpdate = {}
    if (wantPassword) update.password = account.password
    if (wantKey) {
        // Settings hold the PRIVATE key; the app stores the matching PUBLIC one.
        // Deriving it means the two can't disagree.
        const accEnv = privateKeyEnvFor(env.name)
        const keyVar = privateKeyVar(SHARED_ACCOUNTS[role], accEnv)
        const privatePem = vars[keyVar]
        if (!privatePem) {
            throw new Error(
                `Missing ${keyVar} — set the results private key for ${role} on ${accEnv} ` +
                    'before pushing its public half (or pass --password to fix only the password)'
            )
        }
        update.publicKey = await publicKeyFromPrivatePem(privatePem)
    }

    const fields = Object.keys(update).join(' + ')
    if (opts.yes !== 'true') {
        const ok = await confirm(
            `Overwrite ${fields} for ${account.email} on ${env.name} (${env.baseURL})?\n` +
                (update.publicKey
                    ? '  Rotating the key orphans results already wrapped to the old one.\n'
                    : '') +
                '  [y/N] '
        )
        if (!ok) {
            process.stderr.write('Aborted.\n')
            process.exitCode = 1
            return
        }
    }

    // The endpoints authorize with an SI-admin Clerk session JWT, which loginAs returns.
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
    const result = await api.provisionUser(account.email, update)
    process.stdout.write(`${JSON.stringify(result)}\n`)
}
