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

// A pull can fail for reasons that resetting the working copy cannot fix: a
// stale/missing upstream ref, no tracking branch, or rebase config git refuses to
// act on. Only a true non-fast-forward is "diverged" — the case a reset resolves.
//
// `cannot fast-forward to multiple branches` is the MERGE-path twin of the rebase
// message beside it: `pull --ff-only` hands `merge --ff-only` every FETCH_HEAD entry
// marked for merge, and dies when there is more than one. Same condition, different
// wording, so matching only the rebase spelling left it falling through to
// `skipped-diverged` — "push or open a PR" on a branch level with origin, while the
// Reset button that banner offers just re-ran the same failure.
function isConfigFailure(message: string): boolean {
    return (
        /cannot rebase onto multiple branches/i.test(message) ||
        /cannot fast-forward to multiple branches/i.test(message) ||
        /no such ref was fetched/i.test(message) ||
        /no tracking information/i.test(message) ||
        /couldn't find remote ref/i.test(message)
    )
}

// A pull whose worktree write the OS refused — in practice the Claude sandbox,
// which denies `.claude/skills` (and `.claude/hooks`, `settings.json`) so a
// session cannot rewrite its own instructions. git writes every PERMITTED file
// first and only then reaches the denied one, so it aborts HALF-APPLIED: HEAD
// still on the old commit while the index and worktree hold the new one.
//
// This must not read as divergence. The message matches no isConfigFailure
// pattern and no genuine non-fast-forward, so it used to fall through to
// `skipped-diverged` — telling the user to push or open a PR for a branch with
// nothing to push, while the half-applied worktree went unnamed and read as
// edits they had made themselves.
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
            status: isConfigFailure(detail) ? 'failed' : 'skipped-diverged',
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
