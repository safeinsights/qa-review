import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readIdentityMeta } from '@/engine/access-request'
import { repoDir } from '@/engine/paths'

const execFileAsync = promisify(execFile)

export type GhRunner = (args: string[]) => Promise<string>

const realGh: GhRunner = async args => (await execFileAsync('gh', args, { cwd: repoDir() })).stdout

// Create the access PR, or report the one that already exists. `gh pr create`
// fails when a PR is already open for the branch; that is the SUCCESS path here —
// treating it as an error is what made a pending request look like a failed one.
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
        const message = e instanceof Error ? e.message : String(e)
        if (!/already exists/i.test(message)) throw e
        const listed = await gh([
            'pr',
            'list',
            '--head',
            opts.branch,
            '--state',
            'open',
            '--json',
            'number,url',
        ])
        const prs = JSON.parse(listed || '[]') as Array<{ number: number; url: string }>
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
