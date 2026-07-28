import fs from 'node:fs'
import path from 'node:path'
import { resultsRoot, sessionLockPath } from '@/engine/paths'

export class SessionLockError extends Error {}

interface LockFile {
    pid: number
    startedAt: string
}

// Is `pid` a process we can still see? Signal 0 performs the permission/existence
// check without delivering a signal. EPERM means it exists but belongs to another
// user — still alive, so still a valid owner.
function isAlive(pid: number): boolean {
    try {
        process.kill(pid, 0)
        return true
    } catch (e) {
        return (e as NodeJS.ErrnoException).code === 'EPERM'
    }
}

function readLock(): LockFile | null {
    try {
        const parsed = JSON.parse(fs.readFileSync(sessionLockPath(), 'utf8')) as Partial<LockFile>
        if (typeof parsed.pid !== 'number') return null
        return { pid: parsed.pid, startedAt: String(parsed.startedAt ?? 'unknown') }
    } catch {
        // Missing, unreadable, or corrupt — treat as no lock so a garbled file
        // can't wedge the session permanently.
        return null
    }
}

// Claim the single-session lock, or throw if another LIVE session owns it.
//
// `wx` makes creation atomic: two sessions racing here cannot both succeed, so the
// loser reports the winner's pid instead of silently stealing the rendezvous. A
// lock whose owner is gone (crash, SIGKILL) is stale and gets reclaimed.
// Returns a release function; calling it twice is harmless.
export function acquireSessionLock(): () => void {
    fs.mkdirSync(resultsRoot(), { recursive: true })
    const lockPath = sessionLockPath()

    for (let attempt = 0; attempt < 2; attempt++) {
        try {
            const contents: LockFile = { pid: process.pid, startedAt: new Date().toISOString() }
            fs.writeFileSync(lockPath, JSON.stringify(contents), { flag: 'wx' })
            return makeRelease(lockPath)
        } catch (e) {
            if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e

            const existing = readLock()
            if (existing && isAlive(existing.pid)) {
                throw new SessionLockError(
                    `Another \`qar session\` is already running (pid ${existing.pid}, started ` +
                        `${existing.startedAt}). Only one session may run at a time: they share a ` +
                        `single request channel, so a second one would steal \`qar session-login\` ` +
                        `requests and log in a browser you are not attached to. Stop that session ` +
                        `(kill ${existing.pid}) or use the one already running.`
                )
            }
            // Stale (owner dead) or unparseable — drop it and retry the claim once.
            fs.rmSync(lockPath, { force: true })
        }
    }
    throw new SessionLockError('Could not acquire the session lock; try again.')
}

function makeRelease(lockPath: string): () => void {
    let released = false
    return () => {
        if (released) return
        released = true
        // Only remove the lock if we still own it — a stale-reclaim by another
        // session must not be deleted by our late shutdown.
        const current = readLock()
        if (current?.pid === process.pid) fs.rmSync(lockPath, { force: true })
    }
}

// Path helper re-exported for tests that assert on the lock location.
export { sessionLockPath }
export const _internals = { isAlive, readLock, lockDir: () => path.dirname(sessionLockPath()) }
