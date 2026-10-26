import fs from 'node:fs'
import path from 'node:path'
import type { GhRunner } from '@/cli/commands/open-access-pr'
import { extractJiraKeys } from './jira-keys'
import { hasSecurityContent, stripSecurity } from './public-plan'
import { PLAN_ASSET, PLAN_FILE, releaseDir } from './release-paths'

export interface ReleasePr {
    number: number
    title: string
    author: string
    mergedAt: string
    jiraKeys: string[]
    files: string[]
    additions: number
    deletions: number
    body: string
}

export interface ReleasePrs {
    tag: string
    previousTag: string
    prs: ReleasePr[]
    // In the tag compare but not in the release body — the body is generated and
    // has been seen to miss a third of a release (v1.6.9: 63 PRs, 43 listed).
    notesMissing: number[]
    notesExtra: number[]
}

export interface ReleaseAsset {
    name: string
    url: string
    size: number
    updatedAt: string
}

export interface ReleaseStatus {
    tag: string
    exists: boolean
    canUpload: boolean
    assets: ReleaseAsset[]
    local: { plan: boolean; planDiffers: boolean; results: string[] }
}

const MERGE_SUBJECT = /^Merge pull request #(\d+)\b/
const SQUASH_SUBJECT = /\(#(\d+)\)\s*$/

// PR numbers from the commit subjects of a tag compare. A merge commit names its PR
// up front; a squash commit carries it as a trailing "(#n)". Anything else is a
// commit pushed outside a PR and is skipped.
export function prNumbersFromSubjects(subjects: string[]): number[] {
    const out: number[] = []
    for (const subject of subjects) {
        const m = MERGE_SUBJECT.exec(subject) ?? SQUASH_SUBJECT.exec(subject)
        if (!m) continue
        const n = Number(m[1])
        if (!out.includes(n)) out.push(n)
    }
    return out
}

// PR numbers from the release body's table. Only the FIRST cell is read: later
// cells embed whole PR bodies, which can hold pipes, so a full row split is wrong.
export function prNumbersFromBody(body: string): number[] {
    const out: number[] = []
    for (const line of body.split('\n')) {
        const m = /^\|\s*#(\d+)\s*\|/.exec(line)
        if (m) out.push(Number(m[1]))
    }
    return out
}

export function previousTag(tagsNewestFirst: string[], tag: string): string {
    const i = tagsNewestFirst.indexOf(tag)
    if (i < 0) throw new Error(`${tag} is not a release of this repo`)
    const prev = tagsNewestFirst[i + 1]
    if (!prev) throw new Error(`${tag} has no previous release to compare against`)
    return prev
}

interface ReleaseRow {
    tag_name: string
    body: string | null
}

async function listReleaseRows(gh: GhRunner, repo: string): Promise<ReleaseRow[]> {
    const out = await gh(['api', `repos/${repo}/releases?per_page=50`])
    return JSON.parse(out) as ReleaseRow[]
}

export async function listReleases(gh: GhRunner, repo: string): Promise<string[]> {
    return (await listReleaseRows(gh, repo)).map(r => r.tag_name)
}

async function compareSubjects(
    gh: GhRunner,
    repo: string,
    from: string,
    to: string
): Promise<string[]> {
    const out = await gh([
        'api',
        '--paginate',
        `repos/${repo}/compare/${from}...${to}?per_page=250`,
        '--jq',
        '.commits[] | .commit.message | split("\n")[0]',
    ])
    return out.split('\n').filter(Boolean)
}

interface PrView {
    number: number
    title: string
    author: { login: string }
    mergedAt: string
    headRefName: string
    body: string
    files: { path: string }[]
    additions: number
    deletions: number
}

async function viewPr(gh: GhRunner, repo: string, n: number): Promise<PrView> {
    const out = await gh([
        'pr',
        'view',
        String(n),
        '--repo',
        repo,
        '--json',
        'number,title,author,mergedAt,headRefName,body,files,additions,deletions',
    ])
    return JSON.parse(out) as PrView
}

export async function collectReleasePrs(
    gh: GhRunner,
    repo: string,
    tag: string,
    boards: string[]
): Promise<ReleasePrs> {
    const rows = await listReleaseRows(gh, repo)
    const prev = previousTag(
        rows.map(r => r.tag_name),
        tag
    )
    const numbers = prNumbersFromSubjects(await compareSubjects(gh, repo, prev, tag))
    const prs: ReleasePr[] = []
    for (const n of numbers) {
        const v = await viewPr(gh, repo, n)
        // Title, then branch, then body: the body often quotes OTHER tickets.
        const jiraKeys = extractJiraKeys(`${v.title}\n${v.headRefName}\n${v.body}`, boards)
        prs.push({
            number: v.number,
            title: v.title,
            author: v.author?.login ?? '',
            mergedAt: v.mergedAt,
            jiraKeys,
            files: (v.files ?? []).map(f => f.path),
            additions: v.additions ?? 0,
            deletions: v.deletions ?? 0,
            body: v.body ?? '',
        })
    }
    const inBody = prNumbersFromBody(rows.find(r => r.tag_name === tag)?.body ?? '')
    return {
        tag,
        previousTag: prev,
        prs,
        notesMissing: numbers.filter(n => !inBody.includes(n)),
        notesExtra: inBody.filter(n => !numbers.includes(n)),
    }
}

export function assertUnderReleaseDir(tag: string, file: string): void {
    // realpath on both sides: a symlink inside the dir must not smuggle in a file
    // from outside it.
    fs.mkdirSync(releaseDir(tag), { recursive: true })
    const dir = fs.realpathSync(releaseDir(tag))
    const resolved = fs.existsSync(file) ? fs.realpathSync(file) : path.resolve(file)
    if (resolved !== dir && !resolved.startsWith(`${dir}${path.sep}`)) {
        throw new Error(
            `${file} is not under ${dir}; only files under the release dir are uploaded`
        )
    }
}

async function canUpload(gh: GhRunner, repo: string): Promise<boolean> {
    const out = await gh(['api', `repos/${repo}`, '--jq', '.permissions.push'])
    return out.trim() === 'true'
}

// Only a 404 means "no such release"; offline, expired auth or a rate limit must
// surface, or they would read as a release that does not exist.
function isNotFound(e: unknown): boolean {
    return e instanceof Error && /HTTP 404/.test(e.message)
}

async function remoteAssets(
    gh: GhRunner,
    repo: string,
    tag: string
): Promise<ReleaseAsset[] | null> {
    try {
        const out = await gh(['api', `repos/${repo}/releases/tags/${tag}`])
        const parsed = JSON.parse(out) as {
            assets: {
                name: string
                browser_download_url: string
                size: number
                updated_at: string
            }[]
        }
        return parsed.assets.map(a => ({
            name: a.name,
            url: a.browser_download_url,
            size: a.size,
            updatedAt: a.updated_at,
        }))
    } catch (e) {
        if (isNotFound(e)) return null
        throw e
    }
}

export async function downloadAsset(
    gh: GhRunner,
    repo: string,
    tag: string,
    asset: string,
    dir: string
): Promise<string> {
    fs.mkdirSync(dir, { recursive: true })
    await gh([
        'release',
        'download',
        tag,
        '--repo',
        repo,
        '--pattern',
        asset,
        '--dir',
        dir,
        '--clobber',
    ])
    const file = path.join(dir, asset)
    if (!fs.existsSync(file)) throw new Error(`${asset} was not downloaded from ${tag}`)
    return file
}

// The asset never holds the Security section, so the local plan is compared without
// it: a local plan that differs only by its Security lines has nothing unsaved.
export function localPlanDiffers(local: string, remote: string): boolean {
    return stripSecurity(local) !== remote
}

export async function releaseStatus(
    gh: GhRunner,
    repo: string,
    tag: string,
    dir: string
): Promise<ReleaseStatus> {
    const assets = await remoteAssets(gh, repo, tag)
    const planPath = path.join(dir, PLAN_FILE)
    const plan = fs.existsSync(planPath)
    let planDiffers = false
    if (plan && assets?.some(a => a.name === PLAN_ASSET)) {
        const remote = await downloadAsset(gh, repo, tag, PLAN_ASSET, path.join(dir, 'remote'))
        planDiffers = localPlanDiffers(
            fs.readFileSync(planPath, 'utf8'),
            fs.readFileSync(remote, 'utf8')
        )
    }
    const results = fs.existsSync(dir)
        ? fs.readdirSync(dir).filter(f => /^results-[a-z]+\.json$/.test(f))
        : []
    return {
        tag,
        exists: assets !== null,
        canUpload: await canUpload(gh, repo),
        assets: assets ?? [],
        local: { plan, planDiffers, results },
    }
}

export async function uploadAsset(
    gh: GhRunner,
    repo: string,
    tag: string,
    file: string,
    asName: string
): Promise<string> {
    assertUnderReleaseDir(tag, file)
    if (hasSecurityContent(fs.readFileSync(file, 'utf8'))) {
        throw new Error(
            `refusing to upload ${asName}: it contains security lines; management-app is public`
        )
    }
    // gh names the asset after the file, so copy under the asset name first.
    const stage = path.join(releaseDir(tag), 'upload')
    fs.mkdirSync(stage, { recursive: true })
    const staged = path.join(stage, asName)
    fs.copyFileSync(file, staged)
    // Only the plan is replaceable; results assets are history and must never be overwritten.
    const clobber = asName === PLAN_ASSET ? ['--clobber'] : []
    await gh(['release', 'upload', tag, staged, '--repo', repo, ...clobber])
    const assets = (await remoteAssets(gh, repo, tag)) ?? []
    const uploaded = assets.find(a => a.name === asName)
    if (!uploaded) throw new Error(`${asName} is not on ${tag} after upload`)
    return uploaded.url
}
