import fs from 'node:fs'
import path from 'node:path'
import type { GhRunner } from '@/cli/commands/open-access-pr'
import {
    exists,
    isNotFound,
    listReleaseRows,
    publicPlan,
    type ReleasePrs,
    uploadAsset,
} from './github-release'
import { parsePlanLines } from './plan-lines'
import { hasSecurityContent } from './public-plan'
import { parseRelatedRepos, type RelatedRelease, relatedReleasesSection } from './release-notes'
import { PLAN_ASSET, PLAN_FILE, PRS_FILE, releaseDir } from './release-paths'
import { extractSummary, RELEASE_BODY_LIMIT, spliceSummary } from './release-summary'

export interface CreatedRelease {
    tag: string
    previousTag: string
    // The commit the new tag is made on; empty when the tag already existed.
    target: string
    url: string
    planUrl: string
    bodyFile: string
}

// A hotfix (v1.6.9+a) may be the previous release, but a new release is a plain
// version: versionista's hotfix flow is not ported.
const NEW_TAG = /^v(\d+)\.(\d+)\.(\d+)$/
const ANY_TAG = /^v(\d+)\.(\d+)\.(\d+)(?:\+[0-9A-Za-z.-]+)?$/
const SHA = /^[0-9a-f]{40}$/

function core(tag: string, re: RegExp): number[] | null {
    const m = re.exec(tag)
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null
}

function isNewer(a: number[], b: number[]): boolean {
    for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i]
    return false
}

// The next patch version after a release tag, for the script's usage hint.
export function nextPatch(tag: string): string {
    const v = core(tag, ANY_TAG)
    if (!v) throw new Error(`${tag} is not a version tag`)
    return `v${v[0]}.${v[1]}.${v[2] + 1}`
}

async function latestTag(gh: GhRunner, repo: string): Promise<string | null> {
    try {
        return (await gh(['api', `repos/${repo}/releases/latest`, '--jq', '.tag_name'])).trim()
    } catch (e) {
        if (isNotFound(e)) return null
        throw e
    }
}

async function relatedReleases(gh: GhRunner, raw: string): Promise<RelatedRelease[]> {
    const out: RelatedRelease[] = []
    for (const { repo, label } of parseRelatedRepos(raw)) {
        const tag = await latestTag(gh, repo)
        // A repo with no release has nothing to link; versionista linked a dead v0.0.0.
        if (tag) out.push({ repo, label, tag })
    }
    return out
}

function readFile(file: string, missing: string): string {
    if (!fs.existsSync(file)) throw new Error(`${file} does not exist: ${missing}`)
    return fs.readFileSync(file, 'utf8')
}

// The plan session writes prs.json and plan.md; this checks they still describe
// what would be released, so the release, its changelog and its testing plan agree.
async function plannedRelease(gh: GhRunner, repo: string, tag: string) {
    const dir = releaseDir(tag)
    const hint =
        'make the release with the release-create skill (/release-create), which writes the plan first'
    const prs = JSON.parse(readFile(path.join(dir, PRS_FILE), hint)) as ReleasePrs
    const planPath = path.join(dir, PLAN_FILE)
    const plan = readFile(planPath, hint)
    // The same gate the plan session's save runs; it throws listing every problem.
    parsePlanLines(plan, tag, { prs: prs.prs.map(p => p.number) })
    const newest = (await listReleaseRows(gh, repo)).find(r => !r.draft)?.tag_name
    if (newest !== prs.previousTag) {
        throw new Error(
            `the plan compares against ${prs.previousTag}, but the latest release is now ` +
                `${newest}; regenerate the plan`
        )
    }
    return { prs, plan, planPath }
}

// The commit to tag. The plan was written for prs.head, so a tag pushed since must be
// on that same commit, and main having moved on does not matter: the head is pinned.
async function targetFor(gh: GhRunner, repo: string, tag: string, head: string): Promise<string> {
    if (!(await exists(gh, `repos/${repo}/git/ref/tags/${tag}`))) {
        if (!SHA.test(head)) {
            throw new Error(`prs.json names ${head} as its head, not a commit; regenerate the plan`)
        }
        return head
    }
    if (head === tag) return ''
    const sha = (await gh(['api', `repos/${repo}/commits/${tag}`, '--jq', '.sha'])).trim()
    if (sha !== head) {
        throw new Error(
            `tag ${tag} is on ${sha.slice(0, 7)}, but the plan was written for ` +
                `${head.slice(0, 7)}; move the tag or regenerate the plan`
        )
    }
    return ''
}

export async function createRelease(
    gh: GhRunner,
    repo: string,
    tag: string,
    relatedRaw: string,
    dryRun: boolean
): Promise<CreatedRelease> {
    const version = core(tag, NEW_TAG)
    if (!version) throw new Error(`${tag} is not a release tag; use v<major>.<minor>.<patch>`)
    if (await exists(gh, `repos/${repo}/releases/tags/${tag}`)) {
        throw new Error(`${tag} already has a release; save the plan to it from the Release tab`)
    }
    const { prs, plan, planPath } = await plannedRelease(gh, repo, tag)
    const prevVersion = core(prs.previousTag, ANY_TAG)
    if (prevVersion && !isNewer(version, prevVersion)) {
        throw new Error(`${tag} is not newer than the latest release ${prs.previousTag}`)
    }
    const summary = extractSummary(plan)
    // The release description is public, and the Summary is free text: it can quote
    // an S- line. Same rule as release-summary.
    if (hasSecurityContent(summary)) {
        throw new Error('refusing to publish the summary: it contains security content')
    }
    const body = spliceSummary(
        relatedReleasesSection(await relatedReleases(gh, relatedRaw)),
        summary
    )
    if (body.length > RELEASE_BODY_LIMIT) {
        throw new Error(
            `the release description is ${body.length} characters; GitHub allows ` +
                `${RELEASE_BODY_LIMIT}. Shorten the plan's Summary section.`
        )
    }
    const target = await targetFor(gh, repo, tag, prs.head)

    const dir = releaseDir(tag)
    const bodyFile = path.join(dir, 'release-created.md')
    fs.writeFileSync(bodyFile, body)
    const request = path.join(dir, 'release-create.json')
    fs.writeFileSync(
        request,
        JSON.stringify({
            tag_name: tag,
            name: tag,
            body,
            draft: false,
            ...(target ? { target_commitish: target } : {}),
        })
    )
    // Strip the Security section now, before anything is published: a failure here
    // must leave no release behind.
    const { source } = publicPlan(tag, planPath)
    const result = { tag, previousTag: prs.previousTag, target, bodyFile }
    if (dryRun) return { ...result, url: '', planUrl: '' }
    const url = (
        await gh([
            'api',
            '--method',
            'POST',
            `repos/${repo}/releases`,
            '--input',
            request,
            '--jq',
            '.html_url',
        ])
    ).trim()
    try {
        const planUrl = await uploadAsset(gh, repo, tag, source, PLAN_ASSET)
        return { ...result, url, planUrl }
    } catch (e) {
        throw new Error(
            `${tag} is published at ${url}, but ${PLAN_ASSET} did not upload: ` +
                `${(e as Error).message}. Retry with: qar release-upload --tag ${tag} ` +
                `--file ${planPath} --as ${PLAN_ASSET}`
        )
    }
}
