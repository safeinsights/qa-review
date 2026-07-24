// A tiny client for the free mail.tm disposable-email API, used by the signup
// suite to catch invite emails and read the signup URL. No API key, no config:
// each invited user gets its own freshly-created account (mail.tm rejects '+' so
// plus-addressing on one inbox is impossible). See the signup suite design doc.
const API = 'https://api.mail.tm'

export interface Inbox {
    id: string
    address: string
    token: string
}

export interface Message {
    id: string
    subject: string
    from: string
    text: string
    html: string
}

async function api(path: string, init?: RequestInit): Promise<Response> {
    return fetch(`${API}${path}`, init)
}

// The first active public domain (currently "web-library.net"). Not hardcoded so
// the suite keeps working if mail.tm rotates its domain.
export async function activeDomain(): Promise<string> {
    const res = await api('/domains')
    if (!res.ok) throw new Error(`mail.tm GET /domains failed: ${res.status}`)
    const body = (await res.json()) as { 'hydra:member'?: { domain: string; isActive: boolean }[] }
    const members = body['hydra:member'] ?? []
    const active = members.find(d => d.isActive) ?? members[0]
    if (!active) throw new Error('mail.tm returned no domains')
    return active.domain
}

let seq = 0

// A collision-free-enough local part: a per-process counter + a random suffix.
// (Engine runtime code — Math.random is fine here, unlike workflow scripts.)
function uniqueLocalPart(): string {
    seq += 1
    const rand = Math.random().toString(36).slice(2, 10)
    return `qar-signup-${seq}-${rand}`
}

// Create a fresh mail.tm account and return an authenticated Inbox.
export async function createInbox(domain: string): Promise<Inbox> {
    const address = `${uniqueLocalPart()}@${domain}`
    const password = `Qar-${Math.random().toString(36).slice(2).padEnd(10, '0').slice(0, 10)}-9!`
    const created = await api('/accounts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ address, password }),
    })
    if (!created.ok) throw new Error(`mail.tm POST /accounts failed: ${created.status}`)
    const account = (await created.json()) as { id: string; address: string }

    const tokenRes = await api('/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ address, password }),
    })
    if (!tokenRes.ok) throw new Error(`mail.tm POST /token failed: ${tokenRes.status}`)
    const { token } = (await tokenRes.json()) as { token: string }

    return { id: account.id, address: account.address, token }
}

// Pull the SafeInsights signup URL out of an invite email. Prefers a URL whose
// path looks like the invite/signup flow so an unrelated footer link (e.g.
// unsubscribe) is never chosen. HTML bodies encode `&` as `&amp;` in hrefs, so we
// unescape first; trailing sentence punctuation is stripped. The exact path is
// verified against a real invite during signup-suite wiring — widen if needed.
export function extractSignupUrl(message: Message): string {
    const unescapeEntities = (s: string) =>
        s
            .replace(/&amp;/g, '&')
            .replace(/&#38;/g, '&')
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/&quot;/g, '"')
    const haystack = unescapeEntities(`${message.text}\n${message.html}`)
    const urls = (haystack.match(/https?:\/\/[^\s"'<>)]+/g) ?? []).map(u =>
        u.replace(/[.,;:!?)\]}]+$/, '')
    )
    const signup = urls.find(u => /(sign[-_]?up|accept|invit|activate)/i.test(u))
    if (!signup) {
        throw new Error(`no signup url found in message ${message.id}`)
    }
    return signup
}

// Best-effort delete of a mail.tm account (they also expire on their own).
export async function deleteInbox(inbox: Inbox): Promise<void> {
    await api(`/accounts/${inbox.id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${inbox.token}` },
    }).catch(() => {})
}
