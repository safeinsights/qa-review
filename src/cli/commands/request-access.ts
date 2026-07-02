import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createIdentity } from '@/engine/identity'
import { addMember, readKeyring, writeKeyring } from '@/engine/keyring'
import { repoDir } from '@/engine/paths'
import { configDir } from '@/engine/settings'

const execFileAsync = promisify(execFile)

// A slug for the access branch name, e.g. "Jane Smith" -> "jane-smith".
function slug(name: string): string {
    return name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '')
}

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

// Core: create-or-reuse identity, add to keyring, branch + commit + push the
// keyring change. Returns the public key and whether the identity was created.
export async function requestAccess(
    opts: RequestAccessOptions
): Promise<{ publicKey: string; created: boolean; branch: string }> {
    const git = opts.git ?? realGit
    const { publicKey, created } = await createIdentity(opts.dir)

    const next = addMember(readKeyring(opts.dir), {
        name: opts.name,
        publicKey,
        email: opts.email,
        addedDate: opts.date,
    })
    writeKeyring(opts.dir, next)

    const branch = `access/${slug(opts.name)}`
    await git(['checkout', '-b', branch])
    await git(['add', 'config/keyring.json'])
    await git(['commit', '-m', `Add ${opts.name} to keyring`])
    await git(['push', '-u', 'origin', branch])
    // Return to the user's prior branch so a later `qar sync` doesn't get stuck
    // on the (diverged) access branch. Best-effort — don't fail the request if it
    // can't switch back.
    try {
        await git(['checkout', '-'])
    } catch {
        // stay on the access branch; the PR is already pushed
    }
    return { publicKey, created, branch }
}

// CLI wrapper: resolves name/email/date, runs requestAccess, then opens a PR via
// `gh` (falling back to printed instructions if gh is unavailable).
export async function requestAccessCommand(opts: Record<string, string>): Promise<void> {
    const name = opts.name
    if (!name) throw new Error('request-access: --name "Your Name" is required')
    const email = opts.email ?? (await safeGitConfigEmail())
    const date = new Date().toISOString().slice(0, 10)
    const { branch, created } = await requestAccess({ dir: configDir(), name, email, date })
    console.log(
        `${created ? 'Generated a new identity. ' : 'Reused existing identity. '}Pushed ${branch}.`
    )

    try {
        // Pass --head explicitly: requestAccess() has already switched back to the
        // user's prior branch, so `gh pr create` without --head would target the
        // wrong branch and fail with "no commits between origin/main and <branch>".
        await execFileAsync(
            'gh',
            [
                'pr',
                'create',
                '--base',
                'main',
                '--head',
                branch,
                '--title',
                `Add ${name} to keyring`,
                '--body',
                'Reviewer: run "Approve & rekey" (qar rekey on this branch) before merging.',
            ],
            { cwd: repoDir() }
        )
        console.log('Opened a pull request. A teammate will approve + rekey, then merge.')
    } catch (e) {
        // Surface the real reason (gh prints it to stderr) instead of guessing.
        const detail =
            e instanceof Error ? (e as { stderr?: string }).stderr || e.message : String(e)
        console.log(`Could not open a PR automatically:\n${detail.trim()}`)
        console.log(
            `Open it manually: push branch "${branch}" and create a PR titled "Add ${name} to keyring".`
        )
    }
}

async function safeGitConfigEmail(): Promise<string> {
    try {
        return (await execFileAsync('git', ['config', 'user.email'])).stdout.trim()
    } catch {
        return ''
    }
}
