type FetchImpl = (url: string, init?: RequestInit) => Promise<Response>

export interface CleanupResult {
    ok: boolean
    deleted: string[]
    failed: string[]
    error?: string
    // Per-id HTTP status, for diagnosing failures (e.g. 404 vs 500 vs 403).
    statuses?: Record<string, number>
}

// Tracks the ids a run creates and deletes them via the management-app QA
// endpoints (PR #839). Authorization is the admin session cookie string passed
// in; the endpoints verify isSiAdmin. Studies are deleted before users because a
// study's owner FK references the user.
export class CleanupClient {
    private studies: string[] = []
    private users: string[] = []

    constructor(
        private baseURL: string,
        private cookieHeader: string,
        private fetchImpl: FetchImpl = fetch,
    ) {}

    trackStudy(id: string) {
        this.studies.push(id)
    }

    trackUser(id: string) {
        this.users.push(id)
    }

    // Returns the HTTP status of the DELETE, or 0 if the request itself threw
    // (DNS/connection error) — never throws, so run() always completes.
    private async del(path: string): Promise<number> {
        try {
            const res = await this.fetchImpl(`${this.baseURL}${path}`, {
                method: 'DELETE',
                headers: { Cookie: this.cookieHeader },
            })
            return res.status
        } catch {
            return 0
        }
    }

    async run(): Promise<CleanupResult> {
        const deleted: string[] = []
        const failed: string[] = []
        const statuses: Record<string, number> = {}
        // Studies first (FK ordering), then users.
        for (const id of this.studies) {
            const status = await this.del(`/api/qa/studies/${id}`)
            const key = `study:${id}`
            statuses[key] = status
            ;(status >= 200 && status < 300 ? deleted : failed).push(key)
        }
        for (const id of this.users) {
            const status = await this.del(`/api/qa/users/${id}`)
            const key = `user:${id}`
            statuses[key] = status
            ;(status >= 200 && status < 300 ? deleted : failed).push(key)
        }
        return { ok: failed.length === 0, deleted, failed, statuses }
    }
}
