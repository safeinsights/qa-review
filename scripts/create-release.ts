// Publish a new management-app GitHub release from its finished regression plan:
// the description is Related Releases plus the plan's Summary (the changelog), and
// testing-plan.md is attached. Replaces versionista for management-app; its other
// repos, hotfix and append still use versionista.
//
//   pnpm release:create                      # print the suggested next tag
//   pnpm release:create --tag v1.7.1 --dry-run
//   pnpm release:create --tag v1.7.1
//
// The plan comes first. The release-create skill (/release-create) writes
// .tmp/release/<tag>/plan.md and prs.json, agrees the changelog with the user, and
// then runs this script; that is the normal way to use it.
//
// Kept out of qar and the GUI on purpose: publishing a release is a maintainer
// step, not something a QA session or the app should be able to do.
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { GhRunner } from '@/cli/commands/open-access-pr'
import { listReleaseRows } from '@/engine/github-release'
import { managementAppRepo } from '@/engine/jira-keys'
import { repoDir } from '@/engine/paths'
import { createRelease, nextPatch, refuseInAppSession } from '@/engine/release-create'
import { loadSettings } from '@/engine/settings'

const execFileAsync = promisify(execFile)
const gh: GhRunner = async args =>
    (await execFileAsync('gh', args, { cwd: repoDir(), maxBuffer: 64 * 1024 * 1024 })).stdout

function parseArgs(argv: string[]): { tag: string; dryRun: boolean } {
    let tag = ''
    let dryRun = false
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i]
        if (a === '--dry-run') dryRun = true
        else if (a === '--tag' && argv[i + 1] && !argv[i + 1].startsWith('--')) tag = argv[++i]
        else throw new Error(`unknown argument: ${a}`)
    }
    return { tag, dryRun }
}

async function main() {
    refuseInAppSession(process.env)
    const { tag, dryRun } = parseArgs(process.argv.slice(2))
    const vars = await loadSettings()
    const repo = managementAppRepo(vars)
    if (!tag) {
        const latest = (await listReleaseRows(gh, repo)).find(r => !r.draft)
        console.log(`latest release: ${latest?.tag_name ?? 'none'}`)
        if (latest) console.log(`next patch:     ${nextPatch(latest.tag_name)}`)
        console.log('usage: pnpm release:create --tag <vX.Y.Z> [--dry-run]')
        return
    }
    const result = await createRelease(gh, repo, tag, vars.RELATED_RELEASE_REPOS ?? '', dryRun)
    console.log(JSON.stringify(result, null, 2))
}

main().catch(e => {
    console.error('Error:', (e as Error).message)
    process.exit(1)
})
