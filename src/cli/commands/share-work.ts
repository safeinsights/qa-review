import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { GhRunner } from '@/cli/commands/open-access-pr'
import type { GitRunner } from '@/cli/commands/request-access'
import { slugForName } from '@/engine/access-request'
import { repoDir } from '@/engine/paths'

const execFileAsync = promisify(execFile)

export interface ShareWorkResult {
    url: string
    branch: string
}

// Turn local edits into a pull request. This is the alternative to discarding
// them: a QA person who edited a suite gets their work onto a branch and into
// review instead of having to choose between losing it and leaving the app stuck
// on a permanently-skipped sync.
export async function shareWork(opts: {
    branch: string
    title: string
    body: string
    git?: GitRunner
    gh?: GhRunner
}): Promise<ShareWorkResult> {
    const git = opts.git ?? realGit
    const gh = opts.gh ?? realGh

    if ((await git(['status', '--porcelain'])).trim() === '') {
        throw new Error('Nothing to share — the working copy is clean.')
    }

    // Branch FIRST. Staging before this would leave the commit on whatever branch
    // was checked out (usually main), which is exactly what the user wanted a PR
    // to avoid.
    await git(['checkout', '-b', opts.branch])
    // `add -A`, never `-f`: .gitignore is what keeps config/age-identity.txt and
    // settings.local.json out of the commit. Force-adding would publish a user's
    // private key to a branch.
    await git(['add', '-A'])
    await git(['commit', '-m', opts.title])
    // Until this succeeds the commits exist only on this machine, so every step
    // that could abandon them is sequenced after it.
    await git(['push', '-u', 'origin', opts.branch])

    const url = await createPr(gh, opts)

    // Only now is it safe to leave the branch: the work is on origin and in a PR.
    // Returning to a synced main is what puts the app back in a runnable state —
    // otherwise the next sync still skips and the user is where they started.
    await git(['checkout', 'main'])
    await git(['-c', 'pull.rebase=false', 'pull', '--ff-only'])

    return { url, branch: opts.branch }
}

// A PR that was already opened for this branch is a success, not a failure — the
// same reasoning as openAccessPr: the authoritative check is "does a PR exist for
// this head?", so any create failure falls through to a lookup and the ORIGINAL
// error is only rethrown when that lookup comes back empty.
async function createPr(
    gh: GhRunner,
    opts: { branch: string; title: string; body: string }
): Promise<string> {
    try {
        const out = await gh([
            'pr',
            'create',
            '--base',
            'main',
            '--title',
            opts.title,
            '--body',
            opts.body,
            '--head',
            opts.branch,
            '--json',
            'url',
        ])
        const url = parsePrUrl(out)
        if (url) return url
        return (out || '').trim()
    } catch (e) {
        const existing = await findExistingPr(gh, opts.branch)
        if (existing) return existing
        throw e
    }
}

async function findExistingPr(gh: GhRunner, branch: string): Promise<string> {
    try {
        const listed = await gh(['pr', 'list', '--head', branch, '--json', 'url', '--limit', '1'])
        const parsed = JSON.parse(listed || '[]') as unknown
        if (Array.isArray(parsed) && parsed.length > 0) {
            return String((parsed[0] as { url?: string }).url ?? '')
        }
    } catch {
        // A failed lookup means "no answer", not "no PR" — the caller rethrows the
        // original create error, which describes the real problem.
    }
    return ''
}

function parsePrUrl(out: string): string {
    try {
        const parsed = JSON.parse(out || '') as { url?: string }
        return parsed?.url ? String(parsed.url) : ''
    } catch {
        return ''
    }
}

// Branch names carry a timestamp because sharing is repeatable: a fixed name
// would collide with the user's own previous share (`checkout -b` fails on an
// existing branch) the second time they use the button.
export function shareBranchName(description: string, now: Date): string {
    const stamp = now.toISOString().slice(0, 16).replace(/[-:]/g, '').replace('T', '-')
    // The description is free text a user types into a prompt, so it is routinely a
    // whole sentence. Truncate to keep the ref a reasonable length, trimming any
    // trailing '-' left mid-word so the name doesn't end in a stray separator.
    const slug = (slugForName(description) || 'suite-edits').slice(0, 40).replace(/-$/, '')
    return `qa/${slug}-${stamp}`
}

export async function shareWorkCommand(description: string): Promise<void> {
    const title = description.trim() || 'QA: local suite edits'
    const r = await shareWork({
        branch: shareBranchName(title, new Date()),
        title,
        body: SHARE_PR_BODY,
    })
    console.log(`Opened ${r.url} (branch ${r.branch}). Your checkout is back on a synced main.`)
}

const SHARE_PR_BODY = [
    'Local QA edits shared from the QA Runner app.',
    '',
    'Opened by the "Open a PR" action on the sync banner, which commits the working',
    'copy to a branch so the edits can be reviewed instead of discarded.',
].join('\n')

const realGit: GitRunner = async args =>
    (await execFileAsync('git', args, { cwd: repoDir() })).stdout

const realGh: GhRunner = async args => (await execFileAsync('gh', args, { cwd: repoDir() })).stdout
