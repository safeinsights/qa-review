type FetchImpl = (url: string, init?: RequestInit) => Promise<Response>

export interface CleanupResult {
    ok: boolean
    deleted: string[]
    failed: string[]
    error?: string
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

    private async del(path: string): Promise<boolean> {
        try {
            const res = await this.fetchImpl(`${this.baseURL}${path}`, {
                method: 'DELETE',
                headers: { Cookie: this.cookieHeader },
            })
            return res.ok
        } catch {
            // A thrown fetch (DNS/connection refused) is a failed delete, not a
            // crash: run() must still return the list of ids it couldn't remove.
            return false
        }
    }

    async run(): Promise<CleanupResult> {
        const deleted: string[] = []
        const failed: string[] = []
        // Studies first (FK ordering), then users.
        for (const id of this.studies) {
            const ok = await this.del(`/api/qa/studies/${id}`)
            ;(ok ? deleted : failed).push(`study:${id}`)
        }
        for (const id of this.users) {
            const ok = await this.del(`/api/qa/users/${id}`)
            ;(ok ? deleted : failed).push(`user:${id}`)
        }
        return { ok: failed.length === 0, deleted, failed }
    }
}
