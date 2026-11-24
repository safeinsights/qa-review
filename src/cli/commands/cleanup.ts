import { readFileSync } from 'node:fs'
import { CleanupClient, parseIdList } from '@/engine/cleanup'
import { resolveBaseUrl } from '@/engine/env'
import type { Vars } from '@/engine/settings'

const TOKEN_HINT =
    'Read an ADMIN Clerk session JWT in the signed-in browser with ' +
    '`await window.Clerk.session.getToken({ skipCache: true })` (it lasts ~60s).'

// `--token-file` keeps the JWT out of the transcript. Accepts a bare token or the
// JSON string chrome-devtools `evaluate_script` writes with `filePath`.
export function resolveToken(opts: Record<string, string>): string {
    const inline = opts.token ?? opts.cookie
    if (inline !== undefined && opts['token-file'] !== undefined) {
        throw new Error('Pass --token or --token-file, not both.')
    }
    let token = inline ?? ''
    if (opts['token-file'] !== undefined) {
        token = readFileSync(opts['token-file'], 'utf8').trim()
        if (token.startsWith('"')) token = JSON.parse(token) as string
    }
    token = token.trim()
    if (!token)
        throw new Error(
            `An admin token is required: --token <jwt> or --token-file <path>. ${TOKEN_HINT}`
        )
    return token
}

// Delete test studies/users via the QA cleanup endpoints.
// Flags: --env/--pr, --token <jwt> | --token-file <path>, --studies a,b  --users c,d
// (--cookie is a legacy alias for --token.)
export async function cleanupCommand(opts: Record<string, string>, vars: Vars): Promise<void> {
    const studies = parseIdList(opts.studies, 'study')
    const users = parseIdList(opts.users, 'user')
    const invalid = [
        ...studies.invalid.map(id => `study "${id}"`),
        ...users.invalid.map(id => `user "${id}"`),
    ]
    if (invalid.length > 0) {
        throw new Error(
            `Not a valid id: ${invalid.join(', ')}. Studies take a UUID; users a UUID or an email. Nothing was deleted.`
        )
    }
    if (studies.ids.length === 0 && users.ids.length === 0) {
        throw new Error('Nothing to delete: pass --studies <ids> and/or --users <ids>.')
    }
    const token = resolveToken(opts)
    // Base URL only: cleanup never signs in, so it must not need the accounts' secrets.
    const client = new CleanupClient(resolveBaseUrl(opts, vars), token)
    for (const id of studies.ids) client.trackStudy(id)
    for (const id of users.ids) client.trackUser(id)
    const result = await client.run()
    console.log(JSON.stringify(result))
    if (Object.values(result.statuses ?? {}).includes(401))
        console.error(`401: the token is missing, expired or invalid. ${TOKEN_HINT}`)
    if (!result.ok) process.exitCode = 1
}
