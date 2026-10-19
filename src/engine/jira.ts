import fs from 'node:fs'
import path from 'node:path'
import { markdownToAdf } from 'marklassian'

// Minimal Jira Cloud REST client for posting comments that embed screenshots.
//
// Inline images in a Jira Cloud comment can ONLY be expressed as an ADF `media`
// node, and that node is keyed by a **Media Services file UUID** — which is NOT
// the numeric attachment id returned by the upload endpoint. Markdown/wiki image
// syntax (`![](f.png)`, `!f.png|thumbnail!`) is stored verbatim and renders as
// literal text, which is why the mcp-atlassian `add_comment` path cannot do this.
// The UUID is only exposed indirectly: requesting the attachment content endpoint
// WITHOUT following the redirect returns a Location of `.../file/{uuid}/binary`.

export interface JiraConfig {
    baseUrl: string
    email: string
    apiToken: string
}

export interface MediaSegment {
    type: 'media'
    mediaId: string
    width?: number
    height?: number
}

export interface TextSegment {
    type: 'text'
    text: string
}

export type CommentSegment = TextSegment | MediaSegment

const MEDIA_UUID_RE =
    /\/file\/([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})/

// Resolves the Jira connection details from a flat var map (the merged settings from
// loadSettings(), which already layers settings.local.json — where the GUI stores the
// Jira config — under process.env overrides). This is why `qar jira-comment` no longer
// needs JIRA_USERNAME exported: the GUI's saved "Jira email" is picked up from the
// settings files. The Jira account email is NOT the git email.
export function jiraConfig(vars: Record<string, string | undefined>): JiraConfig {
    const baseUrl = (vars.JIRA_URL ?? 'https://openstax.atlassian.net').replace(/\/+$/, '')
    const email = vars.JIRA_USERNAME ?? ''
    const apiToken = vars.JIRA_API_TOKEN ?? ''
    if (!email) {
        throw new Error(
            'Missing JIRA_USERNAME — your Atlassian account email (e.g. you@rice.edu). ' +
                'Set it in the GUI Settings (Jira email), or pass it inline: ' +
                'JIRA_USERNAME=you@rice.edu qar jira-comment …'
        )
    }
    if (!apiToken) throw new Error('Missing JIRA_API_TOKEN')
    return { baseUrl, email, apiToken }
}

// Back-compat wrapper: resolve straight from process.env. Prefer jiraConfig(vars)
// with loadSettings() so the GUI's saved settings are honored.
export function jiraConfigFromEnv(env: NodeJS.ProcessEnv = process.env): JiraConfig {
    return jiraConfig(env)
}

function authHeader(config: JiraConfig): string {
    return `Basic ${Buffer.from(`${config.email}:${config.apiToken}`).toString('base64')}`
}

function jsonHeaders(config: JiraConfig): Record<string, string> {
    return { Authorization: authHeader(config), 'Content-Type': 'application/json' }
}

// `fetch` rejects with a bare `TypeError: fetch failed` for every transport-level
// failure — offline, DNS, or (the one that actually bites here) the Claude command
// sandbox blocking the host. That message names neither the host nor the cause, so a
// sandbox-blocked `qar jira-comment` was indistinguishable from a broken command and
// cost a validation session two retries. Name the host and the fix instead.
export async function jiraFetch(url: string, init: RequestInit): Promise<Response> {
    try {
        return await fetch(url, init)
    } catch (cause) {
        const reason = cause instanceof Error ? cause.message : String(cause)
        // A malformed baseUrl would throw here too; fall back to the raw URL.
        let host = url
        try {
            host = new URL(url).host
        } catch {}
        throw new Error(
            `Could not reach ${host} (${reason}). Either you are offline, or the command ` +
                `sandbox is blocking the host — add "${host}" to sandbox.network.allowedDomains ` +
                'in .claude/settings.json (takes effect in a NEW session), or re-run with the ' +
                'sandbox disabled.',
            { cause }
        )
    }
}

async function assertOk(response: Response, what: string): Promise<void> {
    if (response.ok) return
    const body = await response.text().catch(() => '')
    throw new Error(`${what} failed (${response.status}): ${body.slice(0, 400)}`)
}

// Extracts the Media Services UUID from an attachment-content redirect Location.
// Exported so the parsing — the easiest part to get wrong — is directly testable.
export function extractMediaId(location: string): string | null {
    return location.match(MEDIA_UUID_RE)?.[1] ?? null
}

export type BodyPart =
    | { kind: 'markdown'; text: string }
    | { kind: 'expand'; title: string; text: string }

const EXPAND_OPEN = /^\{expand:([^}]*)\}[ \t]*\n?/m
const EXPAND_CLOSE = /^\{expand\}[ \t]*/m

// A long validation comment buries the three lines a PM needs under forty PASS
// rows, so PASS rows go inside a collapsed `{expand:Passed (N)}…{expand}` block.
// marklassian has no syntax for ADF's expand node, so the block is split out
// HERE and each part converted separately. A block with no closing tag runs to
// the end rather than being dropped.
// Limitation: the body is split on `{{image:N}}` BEFORE this runs, so an image
// placeholder inside an expand block breaks it; the qa-validate skill forbids that.
export function splitExpands(text: string): BodyPart[] {
    const parts: BodyPart[] = []
    let rest = text
    for (;;) {
        const open = rest.match(EXPAND_OPEN)
        if (!open || open.index === undefined) break
        if (open.index > 0) parts.push({ kind: 'markdown', text: rest.slice(0, open.index) })
        rest = rest.slice(open.index + open[0].length)
        const close = rest.match(EXPAND_CLOSE)
        const end = close?.index ?? rest.length
        parts.push({ kind: 'expand', title: open[1].trim(), text: rest.slice(0, end) })
        rest = close ? rest.slice(end + close[0].length) : ''
    }
    if (rest) parts.push({ kind: 'markdown', text: rest })
    return parts
}

const MENTION_TOKEN = '{{mention}}'

// Lines that start a markdown block of their own; a hard-break marker on the line
// BEFORE one of these would leave a stray trailing space or break the block.
const BLOCK_START = /^(\s*([-*+]|\d+[.)])\s|#{1,6}\s|\||>|```|\{expand)/
// Lines whose own syntax a trailing marker would corrupt (a list item is fine:
// a break inside the item is what a continuation line means).
const NO_MARKER = /^(\s*#{1,6}\s|\||```|\{expand)/

// A validation report is line-oriented, not prose. Markdown folds a single
// newline into a space, so "Decisions needed" posted as one run-on paragraph.
// Every newline that joins two plain lines becomes a markdown hard break
// (two trailing spaces → ADF hardBreak); fenced code is left untouched.
export function hardBreaks(text: string): string {
    const lines = text.split('\n')
    let inFence = false
    return lines
        .map((line, i) => {
            if (line.trimStart().startsWith('```')) inFence = !inFence
            if (inFence) return line
            const next = lines[i + 1]
            const joinable =
                next !== undefined &&
                line.trim() !== '' &&
                next.trim() !== '' &&
                !BLOCK_START.test(next)
            return joinable && !NO_MARKER.test(line) ? `${line.trimEnd()}  ` : line
        })
        .join('\n')
}

function markdownBlocks(text: string): Record<string, unknown>[] {
    if (!text.trim()) return []
    const doc = markdownToAdf(hardBreaks(text)) as { content?: Record<string, unknown>[] }
    return doc.content ?? []
}

// Walks inline text nodes and splits `{{mention}}` into a mention node, which is
// what makes Jira notify the PM — a typed @name in markdown is just text.
function injectMentions(nodes: Record<string, unknown>[], accountId: string): boolean {
    let found = false
    for (const node of nodes) {
        const children = node.content as Record<string, unknown>[] | undefined
        if (!children) continue
        const next: Record<string, unknown>[] = []
        for (const child of children) {
            if (
                child.type === 'text' &&
                typeof child.text === 'string' &&
                child.text.includes(MENTION_TOKEN)
            ) {
                found = true
                const pieces = child.text.split(MENTION_TOKEN)
                pieces.forEach((piece, i) => {
                    if (piece) next.push({ ...child, text: piece })
                    if (i < pieces.length - 1) {
                        next.push({ type: 'mention', attrs: { id: accountId } })
                    }
                })
            } else {
                next.push(child)
            }
        }
        node.content = next
        if (injectMentions(next, accountId)) found = true
    }
    return found
}

// Builds the ADF document for a comment interleaving text and inline images.
// Jira renders ADF, not markdown, so each text segment is converted from markdown
// to ADF (headings, bold/italic, inline code, lists, links) via marklassian and its
// block nodes are spliced in — this is what preserves the formatting Claude writes.
// Media segments become mediaSingle nodes in place, keeping the text/image order.
// `{expand:…}` blocks and `{{mention}}` are handled here too — see `splitExpands` / `injectMentions`.
export function buildCommentAdf(
    segments: CommentSegment[],
    options: { mention?: string } = {}
): Record<string, unknown> {
    const content: Record<string, unknown>[] = []
    for (const segment of segments) {
        if (segment.type === 'text') {
            for (const part of splitExpands(segment.text)) {
                if (part.kind === 'markdown') content.push(...markdownBlocks(part.text))
                else {
                    const inner = markdownBlocks(part.text)
                    if (inner.length === 0) continue
                    content.push({ type: 'expand', attrs: { title: part.title }, content: inner })
                }
            }
        } else {
            const attrs: Record<string, unknown> = {
                id: segment.mediaId,
                type: 'file',
                collection: '',
            }
            if (segment.width) attrs.width = segment.width
            if (segment.height) attrs.height = segment.height
            content.push({
                type: 'mediaSingle',
                attrs: { layout: 'center' },
                content: [{ type: 'media', attrs }],
            })
        }
    }
    if (options.mention) {
        const found = injectMentions(content, options.mention)
        if (!found) {
            content.unshift({
                type: 'paragraph',
                content: [{ type: 'mention', attrs: { id: options.mention } }],
            })
        }
    }
    // An ADF doc must contain at least one node.
    if (!content.length) content.push({ type: 'paragraph', content: [] })
    return { version: 1, type: 'doc', content }
}

// Uploads a local file to the issue and returns its numeric REST attachment id.
export async function uploadAttachment(
    config: JiraConfig,
    issueKey: string,
    filePath: string
): Promise<string> {
    const absolute = path.resolve(filePath)
    const data = fs.readFileSync(absolute)
    const form = new FormData()
    form.append('file', new Blob([data]), path.basename(absolute))
    const response = await jiraFetch(`${config.baseUrl}/rest/api/3/issue/${issueKey}/attachments`, {
        method: 'POST',
        headers: {
            Authorization: authHeader(config),
            // Required by Jira for any state-changing request without a browser session.
            'X-Atlassian-Token': 'no-check',
        },
        body: form,
    })
    await assertOk(response, `Uploading ${path.basename(absolute)}`)
    const created = (await response.json()) as Array<{ id: string }>
    const id = created[0]?.id
    if (!id) throw new Error(`Upload of ${path.basename(absolute)} returned no attachment id`)
    return id
}

export interface UploadedFile {
    filename: string
    url: string
}

// The line appended to a comment body for non-image attachments (the inventory
// page, the results JSON), so a reader can find the files the verdict rests on.
export function attachmentsLine(files: UploadedFile[]): string {
    if (files.length === 0) return ''
    const links = files.map(f => `[${f.filename}](${f.url})`).join(' · ')
    return `**Attachments:** ${links}`
}

// Where a browser with a Jira session can open an uploaded attachment.
export function attachmentUrl(config: JiraConfig, attachmentId: string): string {
    return `${config.baseUrl}/rest/api/3/attachment/content/${attachmentId}`
}

// Resolves an attachment's Media Services UUID from the content endpoint's redirect.
export async function resolveMediaId(config: JiraConfig, attachmentId: string): Promise<string> {
    const response = await jiraFetch(
        `${config.baseUrl}/rest/api/3/attachment/content/${attachmentId}`,
        { method: 'GET', headers: { Authorization: authHeader(config) }, redirect: 'manual' }
    )
    const location = response.headers.get('location') ?? ''
    const mediaId = extractMediaId(location)
    if (!mediaId) {
        throw new Error(
            `Could not resolve media id for attachment ${attachmentId} ` +
                `(status ${response.status}, location "${location.slice(0, 120)}")`
        )
    }
    return mediaId
}

export async function addCommentAdf(
    config: JiraConfig,
    issueKey: string,
    adf: Record<string, unknown>
): Promise<{ id: string; url: string }> {
    const response = await jiraFetch(`${config.baseUrl}/rest/api/3/issue/${issueKey}/comment`, {
        method: 'POST',
        headers: jsonHeaders(config),
        body: JSON.stringify({ body: adf }),
    })
    await assertOk(response, 'Adding comment')
    const created = (await response.json()) as { id: string }
    return {
        id: created.id,
        url: `${config.baseUrl}/browse/${issueKey}?focusedCommentId=${created.id}`,
    }
}

export async function deleteComment(
    config: JiraConfig,
    issueKey: string,
    commentId: string
): Promise<void> {
    const response = await jiraFetch(
        `${config.baseUrl}/rest/api/3/issue/${issueKey}/comment/${commentId}`,
        { method: 'DELETE', headers: { Authorization: authHeader(config) } }
    )
    // A comment that's already gone is a success for our purposes.
    if (response.status === 404) return
    await assertOk(response, `Deleting comment ${commentId}`)
}

export interface JiraAttachment {
    id: string
    filename: string
    mimeType: string
    size: number
}

const TEXT_EXTENSIONS = new Set(['.md', '.txt', '.csv'])

// Text attachments (a developer's test plan, a CSV of cases) add requirements the
// card text leaves out. Images are listed but never downloaded — the validator can't
// read them, and a binary "text" file would just be garbage under .tmp/.
export function isTextAttachment(attachment: JiraAttachment): boolean {
    return (
        attachment.mimeType.startsWith('text/') ||
        TEXT_EXTENSIONS.has(path.extname(attachment.filename).toLowerCase())
    )
}

// The MCP's jira_get_issue omits attachments unless `fields` names them, and even
// then returns metadata only — this is the path to their CONTENT.
export async function listAttachments(
    config: JiraConfig,
    issueKey: string
): Promise<JiraAttachment[]> {
    const response = await jiraFetch(
        `${config.baseUrl}/rest/api/3/issue/${issueKey}?fields=attachment`,
        { method: 'GET', headers: { Authorization: authHeader(config) } }
    )
    await assertOk(response, `Listing attachments on ${issueKey}`)
    const body = (await response.json()) as { fields?: { attachment?: JiraAttachment[] } }
    return (body.fields?.attachment ?? []).map(a => ({
        id: String(a.id),
        filename: a.filename,
        mimeType: a.mimeType ?? '',
        size: a.size,
    }))
}

// Same endpoint resolveMediaId uses, but following the redirect to the bytes. The
// redirect leaves the Jira site for the Media Services host, so it is followed by
// hand: an automatic follow that fails would be reported as "could not reach
// <Jira host>", naming a host that is already allowlisted instead of the one that
// is not. The Location carries its own token, and fetch would drop the Jira
// Authorization header on that cross-origin hop anyway, so none is sent.
export async function downloadAttachment(
    config: JiraConfig,
    attachmentId: string,
    destPath: string
): Promise<void> {
    let response = await jiraFetch(
        `${config.baseUrl}/rest/api/3/attachment/content/${attachmentId}`,
        { method: 'GET', headers: { Authorization: authHeader(config) }, redirect: 'manual' }
    )
    const location = response.headers.get('location')
    if (response.status >= 300 && response.status < 400 && location) {
        const target = new URL(location, config.baseUrl).toString()
        response = await jiraFetch(target, { method: 'GET' })
    }
    await assertOk(response, `Downloading attachment ${attachmentId}`)
    fs.mkdirSync(path.dirname(destPath), { recursive: true })
    fs.writeFileSync(destPath, Buffer.from(await response.arrayBuffer()))
}

// Issue-type and link-type NAMES are per-site configuration. A wrong name is a
// Jira 400 naming nothing useful, so both are checked before a card is created.
export async function issueTypeNames(config: JiraConfig, projectKey: string): Promise<string[]> {
    const response = await jiraFetch(
        `${config.baseUrl}/rest/api/3/issue/createmeta/${projectKey}/issuetypes`,
        { method: 'GET', headers: { Authorization: authHeader(config) } }
    )
    await assertOk(response, `Reading issue types for ${projectKey}`)
    const body = (await response.json()) as { issueTypes?: Array<{ name: string }> }
    return (body.issueTypes ?? []).map(t => t.name)
}

export async function linkTypeNames(config: JiraConfig): Promise<string[]> {
    const response = await jiraFetch(`${config.baseUrl}/rest/api/3/issueLinkType`, {
        method: 'GET',
        headers: { Authorization: authHeader(config) },
    })
    await assertOk(response, 'Reading issue link types')
    const body = (await response.json()) as { issueLinkTypes?: Array<{ name: string }> }
    return (body.issueLinkTypes ?? []).map(t => t.name)
}

// Created with summary only: the description needs media ids, and media can only
// be uploaded to an issue that already exists, so the description is PUT afterwards.
export async function createIssue(
    config: JiraConfig,
    fields: { project: string; type: string; summary: string }
): Promise<{ key: string; id: string }> {
    const response = await jiraFetch(`${config.baseUrl}/rest/api/3/issue`, {
        method: 'POST',
        headers: jsonHeaders(config),
        body: JSON.stringify({
            fields: {
                project: { key: fields.project },
                issuetype: { name: fields.type },
                summary: fields.summary,
            },
        }),
    })
    await assertOk(response, 'Creating issue')
    const created = (await response.json()) as { id: string; key: string }
    return { key: created.key, id: created.id }
}

export async function updateDescriptionAdf(
    config: JiraConfig,
    issueKey: string,
    adf: Record<string, unknown>
): Promise<void> {
    const response = await jiraFetch(`${config.baseUrl}/rest/api/3/issue/${issueKey}`, {
        method: 'PUT',
        headers: jsonHeaders(config),
        body: JSON.stringify({ fields: { description: adf } }),
    })
    await assertOk(response, `Setting description on ${issueKey}`)
}

export async function linkIssues(
    config: JiraConfig,
    link: { type: string; inward: string; outward: string }
): Promise<void> {
    const response = await jiraFetch(`${config.baseUrl}/rest/api/3/issueLink`, {
        method: 'POST',
        headers: jsonHeaders(config),
        body: JSON.stringify({
            type: { name: link.type },
            inwardIssue: { key: link.inward },
            outwardIssue: { key: link.outward },
        }),
    })
    await assertOk(response, `Linking ${link.inward} to ${link.outward}`)
}
