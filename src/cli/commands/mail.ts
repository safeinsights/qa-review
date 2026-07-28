import fs from 'node:fs'
import path from 'node:path'
import { INVITE_EMAIL_TIMEOUT_MS, isInviteEmail } from '@/engine/flows/signup'
import {
    activeDomain,
    createInbox,
    extractSignupUrl,
    type Inbox,
    waitForMessage,
} from '@/engine/mailtm'
import { resultsRoot } from '@/engine/paths'

// Where a created inbox's { id, address, token } is stashed so `mail-wait` can poll
// it in a SEPARATE process. Keyed by address (one file per inbox), under the
// gitignored results/ dir. This lets the MCP-driven validation reuse the tested
// mail.tm client via Bash instead of hand-writing throwaway scripts.
function inboxStorePath(address: string): string {
    const safe = address.replace(/[^A-Za-z0-9._@-]/g, '_')
    return path.join(resultsRoot(), 'mail', `${safe}.json`)
}

// `qar mail-inbox` — create a fresh mail.tm inbox and print its email address (only
// the address, on its own line, so a caller can capture it). The inbox's auth token
// is persisted so `mail-wait <address>` can read the mailbox later.
export async function mailInboxCommand(): Promise<void> {
    const domain = await activeDomain()
    const inbox = await createInbox(domain)
    const store = inboxStorePath(inbox.address)
    fs.mkdirSync(path.dirname(store), { recursive: true })
    fs.writeFileSync(store, JSON.stringify(inbox))
    process.stdout.write(`${inbox.address}\n`)
}

// `qar mail-wait --address <addr>` — wait for the SafeInsights invite/signup email
// in that inbox and print the extracted signup URL (only the URL). Uses the stored
// inbox token. Exits non-zero if the inbox is unknown or no email arrives in time.
export async function mailWaitCommand(opts: Record<string, string>): Promise<void> {
    const address = opts.address ?? ''
    if (!address) throw new Error('mail-wait requires --address <inbox-email>')
    const store = inboxStorePath(address)
    let inbox: Inbox
    try {
        inbox = JSON.parse(fs.readFileSync(store, 'utf8')) as Inbox
    } catch {
        throw new Error(`unknown inbox ${address} — run \`qar mail-inbox\` first`)
    }
    const message = await waitForMessage(inbox, isInviteEmail, INVITE_EMAIL_TIMEOUT_MS)
    process.stdout.write(`${extractSignupUrl(message)}\n`)
}
