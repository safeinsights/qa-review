import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { openAccessPr } from '@/cli/commands/open-access-pr'
import { branchForName, readIdentityMeta } from '@/engine/access-request'
import { createIdentity } from '@/engine/identity'
import { addMember, readKeyring, writeKeyring } from '@/engine/keyring'
import { repoDir } from '@/engine/paths'
import { configDir } from '@/engine/settings'

const execFileAsync = promisify(execFile)

// Injectable git runner so the core is unit-testable. Default shells out to git.
export type GitRunner = (args: string[]) => Promise<string>

const realGit: GitRunner = async args =>
    (await execFileAsync('git', args, { cwd: repoDir() })).stdout

export interface RequestAccessOptions {
    dir: string
    name: string
    email: string
    date: string
    git?: GitRunner
}

// Create-or-reuse the identity, add it to the keyring, and push the access branch.
// Every step is idempotent: re-running for the same person reuses the same key, the
// same keyring entry, and the same branch rather than producing a second request.
export async function requestAccess(
    opts: RequestAccessOptions
): Promise<{ publicKey: string; created: boolean; branch: string }> {
    const git = opts.git ?? realGit

    // An identity file's stored branch/name (if any) is the source of truth for
    // WHICH branch this key's request lives on. Deriving the branch fresh from
    // opts.name every time meant a later request under a different name (e.g. git
    // config was edited, or the first request used an explicit --name) computed a
    // DIFFERENT slug and pushed a second branch + a second keyring entry sharing
    // the same key. Once a request exists for this key, its branch never moves —
    // an explicit --name still updates the keyring entry's display name, but is
    // not allowed to fork a second branch for the same person.
    const existingMeta = readIdentityMeta(opts.dir)
    const name = existingMeta?.name ?? opts.name
    const branch = existingMeta?.branch ?? branchForName(opts.name)
    const { publicKey, created } = await createIdentity(opts.dir, { name, branch })

    const next = addMember(readKeyring(opts.dir), {
        name: opts.name,
        publicKey,
        email: opts.email,
        addedDate: opts.date,
    })
    writeKeyring(opts.dir, next)

    // Reuse the branch if it exists — `checkout -b` fails on a second run, which is
    // half of what forced users to rename themselves to get a fresh slug.
    try {
        await git(['rev-parse', '--verify', branch])
        await git(['checkout', branch])
    } catch {
        await git(['checkout', '-b', branch])
    }
    await git(['add', 'config/keyring.json'])
    // Nothing to commit on a re-run (the entry is already there); that is fine.
    try {
        await git(['commit', '-m', `Add ${opts.name} to keyring`])
    } catch {
        // no-op: the keyring entry was already committed on a previous attempt
    }
    await git(['push', '-u', 'origin', branch])
    // Return to the user's prior branch so a later `qar sync` doesn't get stuck
    // on the (diverged) access branch. Best-effort.
    try {
        await git(['checkout', '-'])
    } catch {
        // stay on the access branch; the PR is already pushed
    }
    return { publicKey, created, branch }
}

// Injectable so a test can pin both branches of the fallback without shelling
// out to git. Default resolves via `git config user.name`.
export type NameResolver = () => Promise<string>

// Resolves the --name flag against a name resolver (default: git config user.name).
// An empty string is not a meaningful explicit name (the GUI sends '' to mean
// "derive it"), so it is treated the same as an absent flag, not as an explicit
// value — `||`, not `??`, since parseArgs always yields a string and '' is the
// one falsy value opts.name can take.
export async function resolveRequestAccessName(
    opts: Record<string, string>,
    resolveName: NameResolver = safeGitConfigName
): Promise<string> {
    const name = opts.name || (await resolveName())
    if (!name) {
        throw new Error('request-access: --name "Your Name" is required (git user.name is unset)')
    }
    return name
}

// CLI wrapper: resolves name/email/date, runs requestAccess, then opens a PR via
// `gh` (falling back to printed instructions if gh is unavailable).
export async function requestAccessCommand(opts: Record<string, string>): Promise<void> {
    const name = await resolveRequestAccessName(opts)
    const email = opts.email ?? (await safeGitConfigEmail())
    const date = new Date().toISOString().slice(0, 10)
    const { branch, created } = await requestAccess({ dir: configDir(), name, email, date })
    console.log(
        `${created ? 'Generated a new identity. ' : 'Reused existing identity. '}Pushed ${branch}.`
    )

    try {
        const { url, created: prCreated } = await openAccessPr({ branch, name })
        console.log(
            prCreated
                ? `Opened ${url} — a teammate will approve + rekey, then merge.`
                : `A pull request is already open: ${url}`
        )
    } catch (e) {
        const detail =
            e instanceof Error ? (e as { stderr?: string }).stderr || e.message : String(e)
        console.log(`Could not open a PR automatically:\n${detail.trim()}`)
        console.log(`Retry with: qar open-access-pr`)
    }
}

async function safeGitConfigName(): Promise<string> {
    try {
        return (await execFileAsync('git', ['config', 'user.name'])).stdout.trim()
    } catch {
        return ''
    }
}

async function safeGitConfigEmail(): Promise<string> {
    try {
        return (await execFileAsync('git', ['config', 'user.email'])).stdout.trim()
    } catch {
        return ''
    }
}
