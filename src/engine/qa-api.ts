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

// The study lifecycle states the endpoint accepts.
export const STUDY_STATUSES = [
    'APPROVED',
    'ARCHIVED',
    'CHANGE-REQUESTED',
    'DRAFT',
    'PENDING-REVIEW',
    'REJECTED',
] as const
export type StudyStatus = (typeof STUDY_STATUSES)[number]

export const JOB_STATUSES = [
    'CODE-APPROVED',
    'CODE-CHANGES-REQUESTED',
    'CODE-REJECTED',
    'CODE-SCANNED',
    'CODE-SUBMITTED',
    'FILES-APPROVED',
    'FILES-REJECTED',
    'INITIATED',
    'JOB-ERRORED',
    'JOB-PACKAGING',
    'JOB-PROVISIONING',
    'JOB-READY',
    'JOB-RUNNING',
    'RUN-COMPLETE',
] as const
export type JobStatus = (typeof JOB_STATUSES)[number]

// Artifacts attach to the study's LATEST job. Files are sent as PLAINTEXT and
// encrypted server-side to the reviewing org — QA has no enclave to produce
// ciphertext. That means the reviewing org must already have a public key enrolled,
// or the endpoint answers 400 (fix with provisionUser's publicKey / `qar fix-account`).
export interface QaStudyStateUpdate {
    studyStatus?: StudyStatus
    jobStatus?: JobStatus
    // Plaintext bytes; the server wraps them in the encrypted-zip envelope.
    result?: { name: string; content: string | Uint8Array }
    log?: { name: string; content: string | Uint8Array }
}

export interface QaStudyStateResult {
    studyId: string
    studyJobId: string | null
    studyStatus: StudyStatus
    jobStatus: JobStatus | null
    files: { key: 'result' | 'log'; fileType: string; name: string }[]
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
    // A study has no email of its own, so its RESEARCHER's address is what the guard
    // checks — which is why a study created by a real user is refused too.
    const hint =
        res.status === 403
            ? ' — the endpoints only touch QA accounts (email local part starts with "qa"); ' +
              "for a study that means its researcher's address"
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

    // Drive a study (and its latest job) to a given state, optionally attaching result
    // and/or log artifacts — without an enclave run. This is what makes "results are
    // back and awaiting review" reachable in seconds, and reachable AT ALL on a PR
    // preview, where no compute backend exists to produce them.
    //
    // Omitted fields are left untouched; setting nothing is a 400 rather than a silent
    // no-op. Files attach to the study's LATEST job, so a study with no job is a 400.
    async setStudyState(studyId: string, update: QaStudyStateUpdate): Promise<QaStudyStateResult> {
        // multipart, not JSON — the point of the endpoint is attaching a file, and the
        // statuses ride along as ordinary form fields. Content-Type is deliberately NOT
        // set: fetch derives it from the FormData so the multipart boundary matches.
        const form = new FormData()
        if (update.studyStatus) form.append('studyStatus', update.studyStatus)
        if (update.jobStatus) form.append('jobStatus', update.jobStatus)
        for (const key of ['result', 'log'] as const) {
            const file = update[key]
            if (!file) continue
            // A plain string under this key would be stored as a file containing that
            // literal text, so it must go as a Blob.
            form.append(key, new Blob([file.content as BlobPart]), file.name)
        }

        const res = await this.fetchImpl(
            `${this.baseURL}/api/qa/studies/${encodeURIComponent(studyId)}/status`,
            {
                method: 'PATCH',
                headers: { Authorization: `Bearer ${this.authToken}` },
                body: form,
            }
        )
        if (!res.ok) throw await errorFor(res, `setting state for study ${studyId}`)
        return (await res.json()) as QaStudyStateResult
    }
}
