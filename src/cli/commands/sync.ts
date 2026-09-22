import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { GitRunner } from '@/cli/commands/request-access'
import { isInDrift } from '@/engine/keyring'
import { repoDir } from '@/engine/paths'
import { configDir } from '@/engine/settings'

const execFileAsync = promisify(execFile)

export type SyncStatus = 'synced' | 'skipped-dirty' | 'skipped-diverged' | 'failed'
export interface SyncResult {
    status: SyncStatus
    drift: boolean
    // git's own stderr for a failed pull. Without it the UI can only guess at the
    // cause, and every failure looks like divergence.
    detail?: string
}

// Only a genuine non-fast-forward is "diverged" — the one case a reset resolves.
// git prints a single stable line for it. Every other pull failure (stale upstream
// ref, no tracking branch, unusable rebase config, anything new) reports as
// `failed` carrying git's own stderr, so an unrecognised message can never be
// misread as "push or open a PR".
const nonFastForwardRE = /not possible to fast-forward/i

// A pull whose worktree write the OS refused — in practice the Claude sandbox,
// which denies `.claude/skills` (and `.claude/hooks`, `settings.json`) so a
// session cannot rewrite its own instructions. git writes every PERMITTED file
// first and only then reaches the denied one, so it aborts HALF-APPLIED: HEAD
// still on the old commit while the index and worktree hold the new one.
//
// It is matched separately only to append the recovery hint below: the
// half-applied worktree is invisible unless the user is told to look for it.
//
// Matching the write VERB and not the errno alone is deliberate: `Permission
// denied` also ends `git@github.com: Permission denied (publickey)`, an auth
// failure with an entirely different fix.
const blockedWriteRE =
    /(unable to (unlink|create|write|rename|checkout)|cannot (create directory|stat))[^\n]*(operation not permitted|permission denied)/i

function isBlockedWriteFailure(message: string): boolean {
    return blockedWriteRE.test(message)
}

// Appended to git's stderr, which names the file but neither the cause nor the
// recovery. The half-applied worktree is the expensive part — it is invisible
// unless the user is told to look for it.
const blockedWriteHint = [
    'A file write was refused by the OS. Under the Claude sandbox `.claude/` is not writable,',
    'so the pull may have applied PARTWAY — check `git status`.',
    'Sync from the QA Runner Sync button, which runs outside the sandbox, or re-run with the sandbox off.',
].join(' ')

function gitIn(cwd: string): GitRunner {
    return async args => (await execFileAsync('git', args, { cwd })).stdout
}

// git writes its diagnostics to stderr, which execFile hangs off the rejection
// rather than putting in `message` — so the useful text is lost if we read only
// `message`.
function gitErrorText(e: unknown): string {
    const err = e as { stderr?: string; message?: string }
    return (err?.stderr?.trim() || err?.message || String(e)).trim()
}

// Fast-forward-only pull. Skips (never resets) when the working copy is dirty or
// the pull can't fast-forward. After a successful pull, reports keyring drift.
export async function syncRepo(_repoDir: string, git: GitRunner): Promise<SyncResult> {
    const dirty = (await git(['status', '--porcelain'])).trim() !== ''
    if (dirty) return { status: 'skipped-dirty', drift: false }
    try {
        // `-c pull.rebase=false` is required, not cosmetic: with the user's
        // `pull.rebase true`, `pull --ff-only` runs the REBASE path and dies on
        // config states that are not divergence at all.
        await git(['-c', 'pull.rebase=false', 'pull', '--ff-only'])
    } catch (e) {
        const detail = gitErrorText(e)
        if (isBlockedWriteFailure(detail)) {
            return { status: 'failed', drift: false, detail: `${detail}\n\n${blockedWriteHint}` }
        }
        return {
            status: nonFastForwardRE.test(detail) ? 'skipped-diverged' : 'failed',
            drift: false,
            detail,
        }
    }
    return { status: 'synced', drift: isInDrift(configDir()) }
}

export async function syncCommand(): Promise<void> {
    const dir = repoDir()
    const r = await syncRepo(dir, gitIn(dir))
    switch (r.status) {
        case 'synced':
            console.log(
                'Synced (fast-forward).' +
                    (r.drift ? ' Secrets are out of sync with the keyring — run `qar rekey`.' : '')
            )
            break
        case 'skipped-dirty':
            console.log(
                'Skipped sync — you have local changes. Commit/stash them, or discard uncommitted edits and retry.'
            )
            break
        case 'skipped-diverged':
            console.log(
                'Skipped sync — your branch has diverged (unpushed commits). Push or open a PR, then retry.'
            )
            break
        case 'failed':
            console.log(`Sync failed — git could not pull:\n${r.detail ?? '(no output)'}`)
            break
    }
}
