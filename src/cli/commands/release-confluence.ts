import fs from 'node:fs'
import path from 'node:path'
import {
    attachToPage,
    childPage,
    createPage,
    folderById,
    folderIdFrom,
    setFullWidth,
    updatePage,
} from '@/engine/confluence'
import type { Inventory } from '@/engine/inventory'
import { addRemoteLink, jiraConfig } from '@/engine/jira'
import { jiraBoardsFrom, managementAppRepo } from '@/engine/jira-keys'
import { buildRunPage } from '@/engine/release-confluence'
import { PLAN_ASSET, PLAN_FILE, PRS_FILE, releaseDir, resultsFile } from '@/engine/release-paths'
import { secretValues } from '@/engine/release-results'
import { progressFile, runPlanLinesFile } from '@/engine/release-run-log'
import type { ResultEntry } from '@/engine/results'
import type { Vars } from '@/engine/settings'

function value(opts: Record<string, string>, name: string): string {
    const v = (opts[name] ?? '').trim()
    return v === 'true' ? '' : v
}

function readJson<T>(file: string, what: string): T {
    if (!fs.existsSync(file)) throw new Error(`${what} is missing: ${file}`)
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T
}

// `qar release-confluence --tag <tag> --env <env>` — publish this run's results as a
// page under the RELEASE_CONFLUENCE_FOLDER folder (config/settings.json): folder →
// <tag> → "<tag> <env> — <date> run". Every screenshot named in evidence is attached
// and shown inline, and the security results are on the page, collapsed. The cards
// of the PRs with a FAIL get a link to the page. Prints {"url","title","images",
// "linked","linkFailed"}.
export async function releaseConfluenceCommand(
    opts: Record<string, string>,
    vars: Vars
): Promise<void> {
    const tag = value(opts, 'tag')
    if (!tag) throw new Error('release-confluence requires --tag <release tag>')
    const env = value(opts, 'env')
    if (env !== 'staging' && env !== 'production') {
        throw new Error('release-confluence requires --env staging|production')
    }
    const folderSetting = (vars.RELEASE_CONFLUENCE_FOLDER ?? '').trim()
    if (!folderSetting) {
        throw new Error('RELEASE_CONFLUENCE_FOLDER is not set in config/settings.json')
    }
    const folderId = folderIdFrom(folderSetting)
    const dir = releaseDir(tag)
    const plan = readJson<Inventory>(
        value(opts, 'plan') || path.join(dir, runPlanLinesFile(env)),
        'The run plan lines'
    )
    const results = readJson<{ results: ResultEntry[] }>(
        value(opts, 'results') || path.join(dir, resultsFile(env)),
        'The results (run qar release-results first)'
    ).results
    const prsFile = path.join(dir, PRS_FILE)
    const prs = fs.existsSync(prsFile)
        ? (
              JSON.parse(fs.readFileSync(prsFile, 'utf8')) as {
                  prs: { number: number; title: string; jiraKeys?: string[] }[]
              }
          ).prs
        : undefined
    const releaseUrl = `https://github.com/${managementAppRepo(vars)}/releases/tag/${tag}`
    const shots = path.join(dir, 'shots')
    // The run's own start, not the time of publishing: a republish then updates the
    // same page instead of making another.
    const progressPath = path.join(dir, progressFile(env))
    const startedAt = fs.existsSync(progressPath)
        ? (JSON.parse(fs.readFileSync(progressPath, 'utf8')) as { startedAt?: string }).startedAt
        : undefined
    // The plan as the run used it (the release asset), and the local plan with its
    // Security section: the page is private, so it may hold both.
    const planFiles = [
        {
            path: path.join(dir, 'remote', PLAN_ASSET),
            name: PLAN_ASSET,
            label: 'the plan as run (the release asset)',
        },
        {
            path: path.join(dir, PLAN_FILE),
            name: 'testing-plan-with-security.md',
            label: 'the local plan, with its Security section',
        },
    ].filter(f => fs.existsSync(f.path))
    const page = buildRunPage({
        tag,
        env,
        plan,
        results,
        secrets: secretValues(vars),
        now: startedAt ? new Date(startedAt) : new Date(),
        releaseUrl,
        prs,
        boards: jiraBoardsFrom(vars),
        planFiles: planFiles.map(({ name, label }) => ({ name, label })),
        shotExists: name => fs.existsSync(path.join(shots, name)),
    })

    const config = jiraConfig(vars)
    const folder = await folderById(config, folderId)
    const tagPage =
        (await childPage(config, { id: folder.id, type: 'folder' }, tag)) ??
        (await createPage(config, {
            spaceId: folder.spaceId,
            parentId: folder.id,
            title: tag,
            storage: `<p>Regression runs of management-app <a href="${releaseUrl}">${tag}</a>, one page per run.</p>`,
        }))
    // Attachments need a page, so the run page is made first and filled after.
    let run =
        (await childPage(config, { id: tagPage.id, type: 'page' }, page.title)) ??
        (await createPage(config, {
            spaceId: folder.spaceId,
            parentId: tagPage.id,
            title: page.title,
            storage: '<p>Uploading the results…</p>',
        }))
    for (const name of page.images) await attachToPage(config, run.id, path.join(shots, name))
    for (const f of planFiles) await attachToPage(config, run.id, f.path, f.name)
    run = await updatePage(config, run, page.storage)
    await setFullWidth(config, run.id)

    const linked: string[] = []
    const linkFailed: string[] = []
    for (const key of page.failCards) {
        try {
            await addRemoteLink(config, key, {
                url: run.url,
                title: `Release regression ${tag} on ${env}: FAIL`,
                summary: page.title,
            })
            linked.push(key)
        } catch (e) {
            linkFailed.push(`${key}: ${(e as Error).message}`)
        }
    }
    const record = path.join(dir, `confluence-${env}.json`)
    const pages = fs.existsSync(record)
        ? (JSON.parse(fs.readFileSync(record, 'utf8')) as unknown[])
        : []
    pages.push({ title: run.title, url: run.url, id: run.id, at: new Date().toISOString() })
    fs.writeFileSync(record, `${JSON.stringify(pages, null, 2)}\n`)
    process.stdout.write(
        `${JSON.stringify({ url: run.url, title: run.title, images: page.images.length, linked, linkFailed })}\n`
    )
}
