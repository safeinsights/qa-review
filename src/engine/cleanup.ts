type FetchImpl = (url: string, init?: RequestInit) => Promise<Response>

export interface CleanupResult {
    ok: boolean
    deleted: string[]
    failed: string[]
    error?: string
    // Per-id HTTP status, for diagnosing failures (e.g. 404 vs 500 vs 403).
    statuses?: Record<string, number>
    // Per-id reason for a failure: a 403 can mean "not admin" or "not a qa- account".
    errors?: Record<string, string>
}

interface DeleteOutcome {
    status: number
    gone: boolean
    error?: string
}

// Tracks the ids a run creates and deletes them via the management-app QA
// endpoints. Authorization is a Clerk SESSION JWT (obtained in the page via
// Clerk.session.getToken()) sent as `Authorization: Bearer <jwt>` — the endpoints
// verify it with verifyToken(), then require the caller to be an SI admin OR an
// admin of every org the request targets (a study's enclave AND its lab; for a user,
// every org that account touches). Our shared admin account is an SI admin, so it
// passes unconditionally. (A cookie does NOT work: the auth step only reads the
// Bearer header.) Studies are deleted before users because a study's owner FK
// references the user.
export class CleanupClient {
    private studies: string[] = []
    private users: string[] = []

    constructor(
        private baseURL: string,
        private authToken: string,
        private fetchImpl: FetchImpl = fetch
    ) {}

    trackStudy(id: string) {
        this.studies.push(id)
    }

    trackUser(id: string) {
        this.users.push(id)
    }

    get hasTracked(): boolean {
        return this.studies.length > 0 || this.users.length > 0
    }

    setToken(token: string) {
        this.authToken = token
    }

    // Never throws, so run() always completes; a request that threw is status 0.
    private async del(path: string): Promise<DeleteOutcome> {
        try {
            const res = await this.fetchImpl(`${this.baseURL}${path}`, {
                method: 'DELETE',
                headers: { Authorization: `Bearer ${this.authToken}` },
            })
            return await CleanupClient.outcome(res)
        } catch (e) {
            return { status: 0, gone: false, error: (e as Error).message }
        }
    }

    // 2xx is deleted. A 404 counts as already gone (idempotent teardown) ONLY when it
    // is the route's own JSON "not found": an HTML 404 means the route is missing, and
    // reading that as success would report a cleanup that deleted nothing.
    private static async outcome(res: Response): Promise<DeleteOutcome> {
        const { status } = res
        if (status >= 200 && status < 300) return { status, gone: true }
        const message = await CleanupClient.errorMessage(res)
        if (status === 404 && message !== undefined && /not found/i.test(message)) {
            return { status, gone: true }
        }
        if (status === 404) {
            return {
                status,
                gone: false,
                error: 'the cleanup route itself was not found (no JSON body): is /api/qa deployed here?',
            }
        }
        return { status, gone: false, error: message ?? `HTTP ${status}` }
    }

    private static async errorMessage(res: Response): Promise<string | undefined> {
        try {
            const body = (await res.json()) as { error?: unknown }
            return typeof body.error === 'string' ? body.error : undefined
        } catch {
            return undefined
        }
    }

    async run(): Promise<CleanupResult> {
        const deleted: string[] = []
        const failed: string[] = []
        const statuses: Record<string, number> = {}
        const errors: Record<string, string> = {}
        const targets = [
            ...this.studies.map(id => ({ key: `study:${id}`, path: `/api/qa/studies/${id}` })),
            ...this.users.map(id => ({
                key: `user:${id}`,
                path: `/api/qa/users/${encodeURIComponent(id)}`,
            })),
        ]
        for (const { key, path } of targets) {
            const outcome = await this.del(path)
            statuses[key] = outcome.status
            if (outcome.gone) {
                deleted.push(key)
            } else {
                failed.push(key)
                if (outcome.error) errors[key] = outcome.error
            }
        }
        const result: CleanupResult = { ok: failed.length === 0, deleted, failed, statuses }
        if (Object.keys(errors).length > 0) result.errors = errors
        return result
    }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const EMAIL_RE = /^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/

export interface ParsedIds {
    ids: string[]
    invalid: string[]
}

// Splits a comma list, trimming each entry. The server answers a malformed id with
// the same JSON 404 as a deleted one, so a typo would read as "deleted": reject it
// here instead. Studies take a UUID; users a UUID or an email (the route accepts both).
export function parseIdList(raw: string | undefined, kind: 'study' | 'user'): ParsedIds {
    const ids: string[] = []
    const invalid: string[] = []
    for (const entry of (raw ?? '').split(',')) {
        const id = entry.trim()
        if (!id) continue
        const valid = UUID_RE.test(id) || (kind === 'user' && EMAIL_RE.test(id))
        ;(valid ? ids : invalid).push(id)
    }
    return { ids, invalid }
}
