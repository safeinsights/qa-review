import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
import type { GhRunner } from '@/cli/commands/open-access-pr'
import {
    assertUnderReleaseDir,
    collectReleasePrs,
    downloadAsset,
    listReleases,
    localPlanDiffers,
    releaseStatus,
    uploadAsset,
} from '@/engine/github-release'
import { jiraBoardsFrom, managementAppRepo } from '@/engine/jira-keys'
import { repoDir } from '@/engine/paths'
import { stripSecurity } from '@/engine/public-plan'
import {
    isUploadableAssetName,
    PLAN_ASSET,
    PLAN_FILE,
    PRS_FILE,
    PUBLIC_DIR,
    releaseDir,
} from '@/engine/release-paths'
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

// The plan lands as plan.md, the editor's file, which may hold work the asset does
// not: unsaved edits, and always the local-only Security section. So an existing
// plan.md is replaced only when it equals the asset or --force is given.
function placePlan(remote: string, dest: string, force: boolean): string {
    if (force || !fs.existsSync(dest)) {
        fs.copyFileSync(remote, dest)
        return 'replaced'
    }
    const local = fs.readFileSync(dest, 'utf8')
    const asset = fs.readFileSync(remote, 'utf8')
    if (local === asset) return 'unchanged'
    if (!localPlanDiffers(local, asset))
        return 'kept local (the asset plus the local Security section)'
    throw new Error(
        `refusing to overwrite ${dest}: it has edits that are not on the release; ` +
            'save them, or pass --force to replace them with the asset'
    )
}

// `qar release-download --tag <tag> [--asset testing-plan.md] [--remote-only] [--force]`
// Fetches one asset into .tmp/release/<tag>/remote/. The plan asset is then placed as
// plan.md (see placePlan); --remote-only leaves plan.md alone, which is what a run
// uses so it never reads or replaces a plan someone is editing.
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
    if (opts['remote-only'] === 'true') {
        print({ tag, asset, output: file })
        return
    }
    if (asset !== PLAN_ASSET) {
        const dest = path.join(dir, asset)
        fs.copyFileSync(file, dest)
        print({ tag, asset, output: dest })
        return
    }
    const dest = path.join(dir, PLAN_FILE)
    const plan = placePlan(file, dest, opts.force === 'true')
    print({ tag, asset, output: dest, plan })
}

// Writes the plan without its Security section under public/, which is the file that
// is uploaded. Reading is gated by the path guard first, like the upload itself.
function publicPlan(tag: string, file: string): { source: string; stripped: boolean } {
    assertUnderReleaseDir(tag, file)
    const plan = fs.readFileSync(file, 'utf8')
    const pub = stripSecurity(plan)
    const source = path.join(releaseDir(tag), PUBLIC_DIR, PLAN_ASSET)
    fs.mkdirSync(path.dirname(source), { recursive: true })
    fs.writeFileSync(source, pub)
    return { source, stripped: pub !== plan }
}

function assetNameFor(opts: Record<string, string>, file: string): string {
    const given = (opts.as ?? '').trim()
    if (given === 'true') throw new Error('release-upload requires a value for --as')
    const base = path.basename(file)
    const name = given || (base === PLAN_FILE ? PLAN_ASSET : base)
    if (name !== path.basename(name) || !isUploadableAssetName(name)) {
        throw new Error(
            `${name} is not a release asset name: use ${PLAN_ASSET} or ` +
                'regression-results-<env>-<YYYYMMDD-HHMM>.md'
        )
    }
    return name
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
    const asName = assetNameFor(opts, file)
    const { source, stripped } =
        asName === PLAN_ASSET ? publicPlan(tag, file) : { source: file, stripped: false }
    const url = await uploadAsset(gh, managementAppRepo(vars), tag, source, asName)
    print({ tag, asset: asName, url, stripped })
}
