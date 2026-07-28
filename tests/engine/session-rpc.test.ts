import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

// The session RPC is a pair of files under resultsRoot() that the `qar session-*`
// client commands and the running `qar session` process agree on. resultsRoot()
// derives from QAR_REPO_DIR, so point it at a temp dir and exercise the real
// write/read/consume/result round-trip. Import lazily (after setting the env var)
// so the paths resolve against the temp repo.
let repo: string
let priorRepo: string | undefined

beforeEach(() => {
    priorRepo = process.env.QAR_REPO_DIR
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'qar-rpc-'))
    process.env.QAR_REPO_DIR = repo
})

afterEach(() => {
    if (priorRepo === undefined) delete process.env.QAR_REPO_DIR
    else process.env.QAR_REPO_DIR = priorRepo
    fs.rmSync(repo, { recursive: true, force: true })
})

describe('session RPC round-trip', () => {
    it('a client request is read by the session, then matched by id in the result', async () => {
        const rpc = await import('@/engine/session-rpc')
        const id = rpc.newRequestId()

        rpc.writeSessionRequest(id, { action: 'login', role: 'admin' })

        // Session side: read the pending request and act on it.
        const request = rpc.readSessionRequest()
        expect(request).not.toBeNull()
        expect(request?.id).toBe(id)
        expect(request?.action).toEqual({ action: 'login', role: 'admin' })

        rpc.consumeSessionRequest()
        expect(rpc.readSessionRequest()).toBeNull()

        rpc.writeSessionResult({ id, ok: true, role: 'admin' })

        const result = await rpc.waitForSessionResult(id, 2_000)
        expect(result).toEqual({ id, ok: true, role: 'admin' })
    })

    it('carries create-user / create-study payloads on the result', async () => {
        const rpc = await import('@/engine/session-rpc')
        const userReq = rpc.newRequestId()
        rpc.writeSessionResult({ id: userReq, ok: true, userId: 'u1', email: 'a@b.co' })
        expect(await rpc.waitForSessionResult(userReq, 2_000)).toEqual({
            id: userReq,
            ok: true,
            userId: 'u1',
            email: 'a@b.co',
        })

        const studyReq = rpc.newRequestId()
        rpc.writeSessionResult({ id: studyReq, ok: true, studyId: 's1' })
        expect(await rpc.waitForSessionResult(studyReq, 2_000)).toEqual({
            id: studyReq,
            ok: true,
            studyId: 's1',
        })
    })

    it('ignores a stale result from a previous request (id mismatch) and times out', async () => {
        const rpc = await import('@/engine/session-rpc')
        // A leftover result from an earlier request must not satisfy a new one.
        rpc.writeSessionResult({ id: 'old', ok: true })
        const result = await rpc.waitForSessionResult('new', 700)
        expect(result).toBeNull()
    })

    it('writeSessionRequest clears any prior result so only the new response is seen', async () => {
        const rpc = await import('@/engine/session-rpc')
        rpc.writeSessionResult({ id: 'prev', ok: true, studyId: 'old-study' })
        rpc.writeSessionRequest('fresh', { action: 'create-study' })
        // The stale result file is gone until the session writes a fresh one.
        const result = await rpc.waitForSessionResult('fresh', 500)
        expect(result).toBeNull()
    })

    it('treats a malformed request file as no request', async () => {
        const rpc = await import('@/engine/session-rpc')
        const { sessionRequestPath } = await import('@/engine/paths')
        fs.mkdirSync(path.dirname(sessionRequestPath()), { recursive: true })
        fs.writeFileSync(sessionRequestPath(), '{ half-written')
        expect(rpc.readSessionRequest()).toBeNull()
    })
})
