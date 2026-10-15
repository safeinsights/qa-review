import fs from 'node:fs'
import { splitBodyIntoSegments } from '@/cli/commands/jira'
import {
    buildCommentAdf,
    createIssue,
    issueTypeNames,
    jiraConfig,
    linkIssues,
    linkTypeNames,
    resolveMediaId,
    updateDescriptionAdf,
    uploadAttachment,
} from '@/engine/jira'
import type { Vars } from '@/engine/settings'

const DEFAULT_TYPE = 'Bug'
const DEFAULT_LINK_TYPE = 'Relates'

function required(opts: Record<string, string>, name: string): string {
    const value = (opts[name] ?? '').trim()
    if (!value) throw new Error(`jira-create-issue requires --${name}`)
    return value
}

function splitList(value: string | undefined): string[] {
    return (value ?? '')
        .split(',')
        .map(s => s.trim())
        .filter(Boolean)
}

// `qar jira-create-issue --project <KEY> --summary <text> --body-file <path.md>
//     [--type Bug] [--images a.png,b.png] [--link <PARENT>] [--link-type Relates]`
//
// A validation follow-up card. The MCP's jira_create_issue stores markdown as literal
// text, can't embed screenshots, and can't link issues — the three things the PM asked
// for — so this reuses the comment pipeline (upload → media id → ADF) on a new issue.
// Both type names are checked first: a bad name is a Jira 400 that names nothing.
export async function jiraCreateIssueCommand(
    opts: Record<string, string>,
    vars: Vars
): Promise<void> {
    const project = required(opts, 'project')
    const summary = required(opts, 'summary')
    const bodyFile = required(opts, 'body-file')
    const body = fs.readFileSync(bodyFile, 'utf8')
    const type = opts.type || DEFAULT_TYPE
    const link = (opts.link ?? '').trim()
    const linkType = opts['link-type'] || DEFAULT_LINK_TYPE
    const images = splitList(opts.images)
    for (const image of images) {
        if (!fs.existsSync(image)) throw new Error(`Image not found: ${image}`)
    }

    const config = jiraConfig(vars)
    const types = await issueTypeNames(config, project)
    if (!types.includes(type)) {
        throw new Error(
            `Issue type "${type}" is not available in ${project}. Valid: ${types.join(', ')}`
        )
    }
    if (link) {
        const linkTypes = await linkTypeNames(config)
        if (!linkTypes.includes(linkType)) {
            throw new Error(
                `Link type "${linkType}" does not exist. Valid: ${linkTypes.join(', ')}`
            )
        }
    }

    const created = await createIssue(config, { project, type, summary })
    const step = async <T>(what: string, run: () => Promise<T>): Promise<T> => {
        try {
            return await run()
        } catch (cause) {
            const reason = cause instanceof Error ? cause.message : String(cause)
            throw new Error(`Created ${created.key}, but ${what} failed: ${reason}`, { cause })
        }
    }

    const mediaIds: string[] = []
    for (const image of images) {
        const attachmentId = await step('uploading an image', () =>
            uploadAttachment(config, created.key, image)
        )
        mediaIds.push(
            await step('resolving an image id', () => resolveMediaId(config, attachmentId))
        )
    }
    const adf = await step('building the description', async () =>
        buildCommentAdf(splitBodyIntoSegments(body, mediaIds))
    )
    await step('setting the description', () => updateDescriptionAdf(config, created.key, adf))
    if (link) {
        await step(`linking to ${link}`, () =>
            linkIssues(config, { type: linkType, inward: created.key, outward: link })
        )
    }
    const url = `${config.baseUrl}/browse/${created.key}`
    process.stdout.write(`${JSON.stringify({ key: created.key, url })}\n`)
}
