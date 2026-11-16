import fs from 'node:fs'
import { assertUploadable, splitBodyIntoSegments } from '@/cli/commands/jira'
import {
    assertIssueExists,
    buildCommentAdf,
    type CreateField,
    createFields,
    createIssue,
    issueTypes,
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

const TEAM_FIELD_NAME = 'Team'

// Jira returns a Team value as an object with an id, but takes the bare id on create.
function teamIdOf(value: unknown): string {
    if (typeof value === 'string') return value
    if (value && typeof value === 'object' && 'id' in value && typeof value.id === 'string') {
        return value.id
    }
    return ''
}

// The Team to file under: --team if given, else the parent's, so a follow-up lands on the
// same team as the card it came from. Resolved before the card exists, because a required
// field that is missing fails the create with a 400 that does not say what to pass.
function resolveTeam(opts: {
    project: string
    type: string
    explicit: string
    teamField: CreateField | undefined
    parentFields: Record<string, unknown>
    link: string
}): Record<string, string> {
    const { project, type, explicit, teamField, parentFields, link } = opts
    if (explicit && !teamField) {
        throw new Error(`jira-create-issue: ${project} ${type} has no ${TEAM_FIELD_NAME} field`)
    }
    if (!teamField) return {}
    const team = explicit || teamIdOf(parentFields[teamField.fieldId])
    if (!team && teamField.required) {
        const parentNote = link ? ` (${link} has no ${TEAM_FIELD_NAME})` : ''
        throw new Error(
            `${project} requires a ${TEAM_FIELD_NAME}${parentNote}. Pass --team with the team id, or --link a card that has one.`
        )
    }
    return team ? { [teamField.fieldId]: team } : {}
}

// `qar jira-create-issue --project <KEY> --summary <text> --body-file <path.md>
//     [--type Bug] [--images a.png,b.png] [--link <PARENT>] [--link-type Relates] [--team <ID>]`
//
// A validation follow-up card. The MCP's jira_create_issue stores markdown as literal
// text, can't embed screenshots, and can't link issues — the three things the PM asked
// for — so this reuses the comment pipeline (upload → media id → ADF) on a new issue.
// Both type names and the Team are checked first: each failure is otherwise a Jira 400
// that names nothing.
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
    // A bare `--link` parses to 'true'; catch it before the card exists.
    if (link === 'true') throw new Error('jira-create-issue: --link needs an issue key')
    const linkType = opts['link-type'] || DEFAULT_LINK_TYPE
    const explicitTeam = (opts.team ?? '').trim()
    if (explicitTeam === 'true') throw new Error('jira-create-issue: --team needs a team id')
    const images = splitList(opts.images)
    for (const image of images) assertUploadable(image)

    const config = jiraConfig(vars)
    const types = await issueTypes(config, project)
    const issueType = types.find(t => t.name === type)
    if (!issueType) {
        throw new Error(
            `Issue type "${type}" is not available in ${project}. Valid: ${types.map(t => t.name).join(', ')}`
        )
    }
    const fields = await createFields(config, project, issueType.id)
    const teamField = fields.find(f => f.name === TEAM_FIELD_NAME)
    let parentFields: Record<string, unknown> = {}
    if (link) {
        const linkTypes = await linkTypeNames(config)
        if (!linkTypes.includes(linkType)) {
            throw new Error(
                `Link type "${linkType}" does not exist. Valid: ${linkTypes.join(', ')}`
            )
        }
        parentFields = await assertIssueExists(config, link, teamField ? [teamField.fieldId] : [])
    }
    const extra = resolveTeam({
        project,
        type,
        explicit: explicitTeam,
        teamField,
        parentFields,
        link,
    })

    const created = await createIssue(config, { project, type, summary, extra })
    const step = async <T>(what: string, run: () => Promise<T>): Promise<T> => {
        try {
            return await run()
        } catch (cause) {
            const reason = cause instanceof Error ? cause.message : String(cause)
            throw new Error(
                `Created ${created.key}, but ${what} failed: ${reason}. Fix ${created.key} by hand; do not re-run, that files a duplicate.`,
                { cause }
            )
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
