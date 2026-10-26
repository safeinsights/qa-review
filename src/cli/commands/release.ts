import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
import type { GhRunner } from '@/cli/commands/open-access-pr'
import {
    collectReleasePrs,
    downloadAsset,
    listReleases,
    releaseStatus,
    uploadAsset,
} from '@/engine/github-release'
import { jiraBoardsFrom, managementAppRepo } from '@/engine/jira-keys'
import { repoDir } from '@/engine/paths'
import { PLAN_ASSET, PRS_FILE, releaseDir } from '@/engine/release-paths'
import type { Vars } from '@/engine/settings'

const execFileAsync = promisify(execFile)
const realGh: GhRunner = async args =>
    (await execFileAsync('gh', args, { cwd: repoDir(), maxBuffer: 64 * 1024 * 1024 })).stdout

function requireTag(opts: Record<string, string>): string {
    const tag = (opts.tag ?? '').trim()
    if (!tag || tag === 'true') throw new Error('this command requires --tag <release tag>')
    return tag
}

function print(value: unknown): void {
    process.stdout.write(`${JSON.stringify(value)}\n`)
}

// `qar release-list` — release tags, newest first.
export async function releaseListCommand(
    _opts: Record<string, string>,
    vars: Vars,
    gh: GhRunner = realGh
): Promise<void> {
    print({ releases: await listReleases(gh, managementAppRepo(vars)) })
}

// `qar release-prs --tag <tag>` — the PR set of a release, from the tag compare.
export async function releasePrsCommand(
    opts: Record<string, string>,
    vars: Vars,
    gh: GhRunner = realGh
): Promise<void> {
    const tag = requireTag(opts)
    const result = await collectReleasePrs(gh, managementAppRepo(vars), tag, jiraBoardsFrom(vars))
    const dir = releaseDir(tag)
    fs.mkdirSync(dir, { recursive: true })
    const out = path.join(dir, PRS_FILE)
    fs.writeFileSync(out, JSON.stringify(result, null, 2))
    print({
        tag,
        previousTag: result.previousTag,
        prs: result.prs.length,
        notesMissing: result.notesMissing.length,
        notesExtra: result.notesExtra.length,
        output: out,
    })
}

// `qar release-status --tag <tag>` — what is on the release and what is local.
export async function releaseStatusCommand(
    opts: Record<string, string>,
    vars: Vars,
    gh: GhRunner = realGh
): Promise<void> {
    const tag = requireTag(opts)
    print(await releaseStatus(gh, managementAppRepo(vars), tag, releaseDir(tag)))
}

// `qar release-download --tag <tag> [--asset regression-plan.md]` — fetch one asset
// into the release dir. The plan asset lands as plan.md, the editor's file.
export async function releaseDownloadCommand(
    opts: Record<string, string>,
    vars: Vars,
    gh: GhRunner = realGh
): Promise<void> {
    const tag = requireTag(opts)
    const asset = (opts.asset ?? PLAN_ASSET).trim()
    if (!asset || asset === 'true') throw new Error('release-download requires a value for --asset')
    if (asset !== path.basename(asset) || asset === '.' || asset === '..') {
        throw new Error(`${asset} is not an asset name`)
    }
    const dir = releaseDir(tag)
    const file = await downloadAsset(
        gh,
        managementAppRepo(vars),
        tag,
        asset,
        path.join(dir, 'remote')
    )
    const dest = path.join(dir, asset === PLAN_ASSET ? 'plan.md' : asset)
    fs.copyFileSync(file, dest)
    print({ tag, asset, output: dest })
}

// `qar release-upload --tag <tag> --file <path> [--as <asset name>]`
export async function releaseUploadCommand(
    opts: Record<string, string>,
    vars: Vars,
    gh: GhRunner = realGh
): Promise<void> {
    const tag = requireTag(opts)
    const file = (opts.file ?? '').trim()
    if (!file || file === 'true') throw new Error('release-upload requires --file <path>')
    const asName = (opts.as ?? '').trim() || path.basename(file)
    const url = await uploadAsset(gh, managementAppRepo(vars), tag, file, asName)
    print({ tag, asset: asName, url })
}
