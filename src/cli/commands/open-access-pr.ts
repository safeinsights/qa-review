import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readIdentityMeta } from '@/engine/access-request'
import { repoDir } from '@/engine/paths'

const execFileAsync = promisify(execFile)

export type GhRunner = (args: string[]) => Promise<string>

const realGh: GhRunner = async args => (await execFileAsync('gh', args, { cwd: repoDir() })).stdout

// Never let a malformed/empty `gh pr list` response surface as a confusing parse
// error — an empty result here just means "fall through to rethrowing the
// original `gh pr create` failure".
function safeParsePrs(listed: string): Array<{ number: number; url: string }> {
    try {
        const parsed = JSON.parse(listed || '[]') as unknown
        return Array.isArray(parsed) ? (parsed as Array<{ number: number; url: string }>) : []
    } catch {
        return []
    }
}

// Create the access PR, or report the one that already exists. `gh pr create`
// fails when a PR is already open for the branch; that is the SUCCESS path here —
// treating it as an error is what made a pending request look like a failed one.
//
// ANY `gh pr create` failure falls through to a `gh pr list --head` lookup, rather
// than gating that fallback on matching gh's error wording (`/already exists/i`).
// Message-matching is brittle — a gh version bump that rewords the error silently
// turns a healthy "already open" case back into a thrown failure. The lookup
// itself is the authoritative check ("is there actually a PR for this branch?"),
// so it's safe to always attempt; a genuine failure (auth, network, ...) still
// surfaces because the list will be empty and the ORIGINAL error is rethrown, not
// a confusing secondary one from the list call.
export async function openAccessPr(opts: {
    branch: string
    name: string
    gh?: GhRunner
}): Promise<{ url: string; created: boolean }> {
    const gh = opts.gh ?? realGh
    try {
        const out = await gh([
            'pr',
            'create',
            '--base',
            'main',
            '--head',
            opts.branch,
            '--title',
            `Add ${opts.name} to keyring`,
            '--body',
            'Reviewer: run "Approve & rekey" (qar rekey on this branch) before merging.',
        ])
        return { url: out.trim(), created: true }
    } catch (e) {
        const listed = await gh([
            'pr',
            'list',
            '--head',
            opts.branch,
            '--state',
            'open',
            '--json',
            'number,url',
        ]).catch(() => '')
        const prs = safeParsePrs(listed)
        if (prs.length === 0) throw e
        return { url: prs[0].url, created: false }
    }
}

export async function openAccessPrCommand(_opts: Record<string, string>): Promise<void> {
    const meta = readIdentityMeta()
    if (!meta?.branch) {
        throw new Error('open-access-pr: no access request found — run "qar request-access" first')
    }
    const { url, created } = await openAccessPr({
        branch: meta.branch,
        name: meta.name ?? meta.branch.replace(/^access\//, ''),
    })
    console.log(created ? `Opened ${url}` : `A pull request is already open: ${url}`)
}
