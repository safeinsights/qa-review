import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

// The session lock is a file under resultsRoot(), which derives from QAR_REPO_DIR.
// Point that at a temp dir and exercise the real acquire/release/stale behavior.
// Import lazily (after setting the env var) so paths resolve against the temp repo.
let repo: string
let priorRepo: string | undefined

beforeEach(() => {
    priorRepo = process.env.QAR_REPO_DIR
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'qar-lock-'))
    process.env.QAR_REPO_DIR = repo
})

afterEach(() => {
    if (priorRepo === undefined) delete process.env.QAR_REPO_DIR
    else process.env.QAR_REPO_DIR = priorRepo
    fs.rmSync(repo, { recursive: true, force: true })
})

// A pid that is almost certainly not a live process. Chosen above the typical
// pid_max wrap so it cannot collide with a real one on the test machine.
const DEAD_PID = 999_999

describe('acquireSessionLock', () => {
    it('creates the lock recording the owning pid, and removes it on release', async () => {
        const { acquireSessionLock } = await import('@/engine/session-lock')
        const { sessionLockPath } = await import('@/engine/paths')

        const release = acquireSessionLock()
        const written = JSON.parse(fs.readFileSync(sessionLockPath(), 'utf8'))
        expect(written.pid).toBe(process.pid)

        release()
        expect(fs.existsSync(sessionLockPath())).toBe(false)
    })

    it('refuses a second acquire while a LIVE owner holds the lock', async () => {
        const { acquireSessionLock, SessionLockError } = await import('@/engine/session-lock')

        const release = acquireSessionLock()
        // process.pid is alive by definition, so this models a running session.
        expect(() => acquireSessionLock()).toThrow(SessionLockError)
        release()
    })

    it("names the holder's pid so the user can stop the right process", async () => {
        const { acquireSessionLock } = await import('@/engine/session-lock')
        const release = acquireSessionLock()
        expect(() => acquireSessionLock()).toThrow(new RegExp(`pid ${process.pid}\\b`))
        release()
    })

    it('reclaims a stale lock whose owner is gone (crash / SIGKILL)', async () => {
        const { acquireSessionLock } = await import('@/engine/session-lock')
        const { sessionLockPath, resultsRoot } = await import('@/engine/paths')

        fs.mkdirSync(resultsRoot(), { recursive: true })
        fs.writeFileSync(
            sessionLockPath(),
            JSON.stringify({ pid: DEAD_PID, startedAt: 'yesterday' })
        )

        const release = acquireSessionLock()
        expect(JSON.parse(fs.readFileSync(sessionLockPath(), 'utf8')).pid).toBe(process.pid)
        release()
    })

    it('reclaims a corrupt lock file rather than wedging the session forever', async () => {
        const { acquireSessionLock } = await import('@/engine/session-lock')
        const { sessionLockPath, resultsRoot } = await import('@/engine/paths')

        fs.mkdirSync(resultsRoot(), { recursive: true })
        fs.writeFileSync(sessionLockPath(), 'not json{{')

        const release = acquireSessionLock()
        expect(JSON.parse(fs.readFileSync(sessionLockPath(), 'utf8')).pid).toBe(process.pid)
        release()
    })

    it('a late release does not delete a lock another session has since reclaimed', async () => {
        const { acquireSessionLock } = await import('@/engine/session-lock')
        const { sessionLockPath } = await import('@/engine/paths')

        const release = acquireSessionLock()
        // Simulate: our process was considered dead and a NEW session took the lock.
        fs.writeFileSync(sessionLockPath(), JSON.stringify({ pid: DEAD_PID, startedAt: 'now' }))

        release()
        // The successor's lock must survive our shutdown.
        expect(fs.existsSync(sessionLockPath())).toBe(true)
        expect(JSON.parse(fs.readFileSync(sessionLockPath(), 'utf8')).pid).toBe(DEAD_PID)
    })

    it('release is idempotent', async () => {
        const { acquireSessionLock } = await import('@/engine/session-lock')
        const release = acquireSessionLock()
        release()
        release()
        // A second session can still claim it afterwards.
        const second = acquireSessionLock()
        second()
    })
})
