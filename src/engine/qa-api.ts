// Client for the management-app's QA provisioning endpoints (management-app PR #912).
// Companion to cleanup.ts, which calls the DELETE side of the same /api/qa surface —
// same auth (a Clerk SESSION JWT as `Authorization: Bearer <jwt>`, verified server-side
// with isSiAdmin) and the same injectable fetch so tests don't need a live app.
//
// These endpoints run on EVERY env including production. The server guards them with
// assertQaEmail: the STORED address of any account they touch must have a local part
// matching /^qa/i, so a real user can't be modified even by passing their id.

type FetchImpl = (url: string, init?: RequestInit) => Promise<Response>

export interface QaOrgMembership {
    slug: string
    isAdmin?: boolean
}

// Every field is optional; an omitted one is left untouched. `orgs: []` is meaningful —
// it removes every membership.
export interface QaUserUpdate {
    orgs?: QaOrgMembership[]
    publicKey?: string
    password?: string
}

export interface QaProvisionResult {
    userId: string
    orgs: { slug: string; isAdmin: boolean }[]
    fingerprint: string | null
    passwordSet: boolean
}

export interface QaInviteRequest {
    email: string
    orgSlug: string
    isAdmin?: boolean
}

export interface QaInviteResult {
    inviteId: string
    email: string
    orgSlug: string
    inviteUrl: string
    // True when an outstanding invite was reused rather than a new one created (the
    // endpoint answers 200 instead of 201).
    alreadyInvited: boolean
}

// The endpoints answer 4xx with `{ error }` (and a `details` array for a Zod failure).
// Surface that text — "is not a QA account" or "organization with slug X not found" is
// the actionable part, and a bare status code hides it.
async function errorFor(res: Response, what: string): Promise<Error> {
    let detail = ''
    try {
        const body = (await res.json()) as { error?: string; details?: unknown }
        detail = body.error ?? ''
        if (body.details) detail += ` (${JSON.stringify(body.details)})`
    } catch {
        detail = await res.text().catch(() => '')
    }
    const hint =
        res.status === 403
            ? ' — the endpoints only touch accounts whose email local part starts with "qa"'
            : ''
    return new Error(`${what} failed (HTTP ${res.status})${detail ? `: ${detail}` : ''}${hint}`)
}

export class QaApiClient {
    constructor(
        private baseURL: string,
        private authToken: string,
        private fetchImpl: FetchImpl = fetch
    ) {}

    private async send(method: string, path: string, body: unknown): Promise<Response> {
        return await this.fetchImpl(`${this.baseURL}${path}`, {
            method,
            headers: {
                Authorization: `Bearer ${this.authToken}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(body),
        })
    }

    // Put an existing account into a known state. `idOrEmail` accepts either; an email
    // is URL-encoded since it travels in the path segment.
    async provisionUser(idOrEmail: string, update: QaUserUpdate): Promise<QaProvisionResult> {
        const res = await this.send(
            'PATCH',
            `/api/qa/users/${encodeURIComponent(idOrEmail)}`,
            update
        )
        if (!res.ok) throw await errorFor(res, `provisioning ${idOrEmail}`)
        return (await res.json()) as QaProvisionResult
    }

    // Mint an invite and get its URL back directly, so a caller can complete signup
    // without waiting on an inbox. The invited ROLE is implied by the org.
    async createInvite(invite: QaInviteRequest): Promise<QaInviteResult> {
        const res = await this.send('POST', '/api/qa/invites', invite)
        if (!res.ok) throw await errorFor(res, `inviting ${invite.email}`)
        return (await res.json()) as QaInviteResult
    }
}
