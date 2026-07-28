import fs from 'node:fs'
import type { InvitedRole } from '@/engine/flows/signup'
import { resultsRoot, sessionRequestPath, sessionRequestResultPath } from '@/engine/paths'
import type { Role } from '@/engine/types'

// The file-based RPC shared by a long-lived `qar session` (the server, which holds
// the streamed browser) and the short-lived `qar session-*` client commands. A
// client writes a SessionRequest to sessionRequestPath(); the session watches that
// path, runs the action on its held page, and writes a SessionResult to
// sessionRequestResultPath(). One session at a time, so a single fixed path pair
// needs no per-request coordination.
//
// Each request carries a unique `id` so a client only ever observes the result of
// its OWN request (a stale result from a previous request is ignored).

export interface LoginRequest {
    action: 'login'
    role: Role
}

export interface CreateUserRequest {
    action: 'create-user'
    role: InvitedRole
}

export interface CreateStudyRequest {
    action: 'create-study'
}

export type SessionAction = LoginRequest | CreateUserRequest | CreateStudyRequest

export interface SessionRequest {
    id: string
    action: SessionAction
}

export interface SessionResult {
    id: string
    ok: boolean
    error?: string
    // Populated on success, per action:
    role?: Role | InvitedRole
    userId?: string
    email?: string
    studyId?: string
}

// Write a request atomically and return its id so the caller can match the result.
export function writeSessionRequest(id: string, action: SessionAction): void {
    fs.mkdirSync(resultsRoot(), { recursive: true })
    // Clear any stale result so we only observe the response to THIS request.
    fs.rmSync(sessionRequestResultPath(), { force: true })
    const tmp = `${sessionRequestPath()}.tmp`
    fs.writeFileSync(tmp, JSON.stringify({ id, action } satisfies SessionRequest))
    fs.renameSync(tmp, sessionRequestPath())
}

// Read the pending request, or null if none / half-written / malformed. A malformed
// or partial file is treated as "no request" so it's simply retried on the next tick.
export function readSessionRequest(): SessionRequest | null {
    let text: string
    try {
        text = fs.readFileSync(sessionRequestPath(), 'utf8')
    } catch {
        return null // no request file
    }
    try {
        const parsed = JSON.parse(text) as SessionRequest
        if (parsed && typeof parsed.id === 'string' && parsed.action) return parsed
    } catch {
        /* malformed — ignore (a half-written file is picked up next tick) */
    }
    return null
}

// Consume (delete) the pending request so a slow action isn't re-triggered.
export function consumeSessionRequest(): void {
    fs.rmSync(sessionRequestPath(), { force: true })
}

export function writeSessionResult(result: SessionResult): void {
    fs.mkdirSync(resultsRoot(), { recursive: true })
    const tmp = `${sessionRequestResultPath()}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(result))
    fs.renameSync(tmp, sessionRequestResultPath())
}

// Poll for the result of the request with this id, or null on timeout.
export async function waitForSessionResult(
    id: string,
    timeoutMs: number
): Promise<SessionResult | null> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
        const result = readSessionResult()
        if (result && result.id === id) return result
        await new Promise(r => setTimeout(r, 300))
    }
    return null
}

function readSessionResult(): SessionResult | null {
    try {
        return JSON.parse(fs.readFileSync(sessionRequestResultPath(), 'utf8')) as SessionResult
    } catch {
        return null // not written yet / mid-write
    }
}

// A unique-enough request id for a single-session-at-a-time channel: the client's
// pid + a wall-clock stamp. The session only checks that the result id matches, so
// collisions across sequential requests just need to differ, which this guarantees.
export function newRequestId(): string {
    return `${process.pid}-${Date.now()}`
}
