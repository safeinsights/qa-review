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
