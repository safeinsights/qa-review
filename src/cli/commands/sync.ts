import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { configDir } from '@/engine/settings'
import { isInDrift } from '@/engine/keyring'
import type { GitRunner } from '@/cli/commands/request-access'

const execFileAsync = promisify(execFile)

export type SyncStatus = 'synced' | 'skipped-dirty' | 'skipped-diverged'
export interface SyncResult {
    status: SyncStatus
    drift: boolean
}

function gitIn(cwd: string): GitRunner {
    return async (args) => (await execFileAsync('git', args, { cwd })).stdout
}

// Fast-forward-only pull. Skips (never resets) when the working copy is dirty or
// the pull can't fast-forward. After a successful pull, reports keyring drift.
export async function syncRepo(repoDir: string, git: GitRunner): Promise<SyncResult> {
    const dirty = (await git(['status', '--porcelain'])).trim() !== ''
    if (dirty) return { status: 'skipped-dirty', drift: false }
    try {
        await git(['pull', '--ff-only'])
    } catch {
        return { status: 'skipped-diverged', drift: false }
    }
    return { status: 'synced', drift: isInDrift(configDir()) }
}

export async function syncCommand(): Promise<void> {
    const repoDir = process.cwd()
    const r = await syncRepo(repoDir, gitIn(repoDir))
    switch (r.status) {
        case 'synced':
            console.log('Synced (fast-forward).' + (r.drift ? ' Secrets are out of sync with the keyring — run `otto rekey`.' : ''))
            break
        case 'skipped-dirty':
            console.log('Skipped sync — you have local changes. Commit/stash them, or discard uncommitted edits and retry.')
            break
        case 'skipped-diverged':
            console.log('Skipped sync — your branch has diverged (unpushed commits). Push or open a PR, then retry.')
            break
    }
}
