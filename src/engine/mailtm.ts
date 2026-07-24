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

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

// All mail.tm requests flow through here. The free tier rate-limits bursts with
// HTTP 429 (and occasionally 503); these are transient, so retry a few times with
// increasing backoff before giving the response back to the caller. Non-retryable
// statuses (and success) return immediately.
async function api(path: string, init?: RequestInit): Promise<Response> {
    const backoffsMs = [500, 1500, 3000, 5000]
    let res = await fetch(`${API}${path}`, init)
    for (
        let attempt = 0;
        attempt < backoffsMs.length && (res.status === 429 || res.status === 503);
        attempt++
    ) {
        await sleep(backoffsMs[attempt])
        res = await fetch(`${API}${path}`, init)
    }
    return res
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

async function listMessages(token: string): Promise<{ id: string }[]> {
    const res = await api('/messages', { headers: { Authorization: `Bearer ${token}` } })
    if (!res.ok) throw new Error(`mail.tm GET /messages failed: ${res.status}`)
    const body = (await res.json()) as { 'hydra:member'?: { id: string }[] }
    return body['hydra:member'] ?? []
}

async function getMessage(token: string, id: string): Promise<Message> {
    const res = await api(`/messages/${id}`, { headers: { Authorization: `Bearer ${token}` } })
    if (!res.ok) throw new Error(`mail.tm GET /messages/${id} failed: ${res.status}`)
    const m = (await res.json()) as {
        id: string
        subject: string
        from: { address: string }
        text?: string
        html?: string[]
    }
    return {
        id: m.id,
        subject: m.subject,
        from: m.from.address,
        text: m.text ?? '',
        html: (m.html ?? []).join('\n'),
    }
}

// Poll the inbox until a message matching `predicate` arrives, then return its
// full body. Bounded by `timeoutMs` (default 60s) — throws if nothing matches in
// time. Poll interval respects mail.tm's 8 QPS limit.
export async function waitForMessage(
    inbox: Inbox,
    predicate: (m: Message) => boolean,
    timeoutMs = 60_000
): Promise<Message> {
    const deadline = Date.now() + timeoutMs
    const seen = new Set<string>()
    while (Date.now() < deadline) {
        try {
            const summaries = await listMessages(inbox.token)
            for (const summary of summaries) {
                if (seen.has(summary.id)) continue
                seen.add(summary.id)
                const full = await getMessage(inbox.token, summary.id)
                if (predicate(full)) return full
            }
        } catch {
            // Transient list/get failure (429/5xx, or a message that expired
            // mid-poll) — keep polling until the deadline rather than aborting.
        }
        const remaining = deadline - Date.now()
        if (remaining <= 0) break
        await sleep(Math.min(2_000, remaining))
    }
    throw new Error(`mail.tm: no matching message for ${inbox.address} within ${timeoutMs}ms`)
}

// Best-effort delete of a mail.tm account (they also expire on their own).
export async function deleteInbox(inbox: Inbox): Promise<void> {
    await api(`/accounts/${inbox.id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${inbox.token}` },
    }).catch(() => {})
}
