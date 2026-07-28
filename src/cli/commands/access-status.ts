import { execFile } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { promisify } from 'node:util'
import type { GhRunner } from '@/cli/commands/open-access-pr'
import type { GitRunner } from '@/cli/commands/request-access'
import { branchForName, readIdentityMeta } from '@/engine/access-request'
import { readIdentity } from '@/engine/identity'
import { readKeyring } from '@/engine/keyring'
import { repoDir } from '@/engine/paths'
import { configDir, decryptWithIdentity, isEncryptedValue, SECRETS_FILE } from '@/engine/settings'

const execFileAsync = promisify(execFile)

const realGit: GitRunner = async args =>
    (await execFileAsync('git', args, { cwd: repoDir() })).stdout
const realGh: GhRunner = async args => (await execFileAsync('gh', args, { cwd: repoDir() })).stdout

export type AccessState =
    | 'no-identity'
    | 'no-branch'
    | 'branch-no-pr'
    | 'pr-open'
    | 'pr-closed'
    | 'merged-awaiting-rekey'
    | 'ready'

export interface AccessStatus {
    state: AccessState
    publicKey: string
    name: string
    branch: string
    pr: { number: number; state: string; url: string } | null
    githubReachable: boolean
    note: string
}

// True only when EVERY encrypted secret decrypts — matching loadSettings(), which
// throws on the first one it can't. A single undecryptable secret still fails a run,
// so "one worked" would be a false green.
async function allSecretsDecrypt(
    dir: string,
    identity: string
): Promise<{ canDecrypt: boolean; checkable: boolean }> {
    const p = path.join(dir, SECRETS_FILE)
    if (!fs.existsSync(p)) return { canDecrypt: false, checkable: false }
    const secrets = JSON.parse(fs.readFileSync(p, 'utf8') || '{}') as Record<string, string>
    let tried = false
    for (const value of Object.values(secrets)) {
        if (!isEncryptedValue(value)) continue
        tried = true
        try {
            await decryptWithIdentity(value, identity)
        } catch {
            return { canDecrypt: false, checkable: true }
        }
    }
    return { canDecrypt: tried, checkable: tried }
}

// Resolve the request state from the local key outward: keyring membership, then the
// remote branch, then the PR. GitHub failures degrade to the best LOCAL answer and
// set githubReachable=false — they must never report "no request".
export async function resolveAccessStatus(opts: {
    dir: string
    git: GitRunner
    gh: GhRunner
    identityName?: string
}): Promise<AccessStatus> {
    const meta = readIdentityMeta(opts.dir)
    const base: AccessStatus = {
        state: 'no-identity',
        publicKey: '',
        name: '',
        branch: '',
        pr: null,
        githubReachable: true,
        note: '',
    }
    if (!meta) return base

    const name = meta.name ?? opts.identityName ?? ''
    const branch = meta.branch ?? (name ? branchForName(name) : '')
    const status: AccessStatus = { ...base, publicKey: meta.publicKey, name, branch }

    const identity = readIdentity(opts.dir)
    const inKeyring = readKeyring(opts.dir).some(m => m.publicKey === meta.publicKey)
    if (inKeyring && identity) {
        const { canDecrypt, checkable } = await allSecretsDecrypt(opts.dir, identity)
        if (canDecrypt || !checkable) return { ...status, state: 'ready' }
        return { ...status, state: 'merged-awaiting-rekey' }
    }

    if (!branch) return { ...status, state: 'no-branch' }

    let remoteHasBranch = false
    try {
        remoteHasBranch = (await opts.git(['ls-remote', '--heads', 'origin', branch])).trim() !== ''
    } catch {
        return {
            ...status,
            state: 'no-branch',
            githubReachable: false,
            note: "Couldn't reach GitHub to check your request — showing local state only.",
        }
    }
    if (!remoteHasBranch) return { ...status, state: 'no-branch' }

    try {
        const listed = await opts.gh([
            'pr',
            'list',
            '--head',
            branch,
            '--state',
            'all',
            '--json',
            'number,state,url',
        ])
        const prs = JSON.parse(listed || '[]') as Array<{
            number: number
            state: string
            url: string
        }>
        if (prs.length === 0) return { ...status, state: 'branch-no-pr' }
        const pr = prs[0]
        const state: AccessState = pr.state === 'OPEN' ? 'pr-open' : 'pr-closed'
        return { ...status, state, pr }
    } catch {
        return {
            ...status,
            state: 'branch-no-pr',
            githubReachable: false,
            note: "Couldn't reach GitHub to check your pull request — showing local state only.",
        }
    }
}

export async function accessStatusCommand(_opts: Record<string, string>): Promise<void> {
    const status = await resolveAccessStatus({
        dir: configDir(),
        git: realGit,
        gh: realGh,
    })
    console.log(JSON.stringify(status))
}
