import fs from 'node:fs'
import path from 'node:path'

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

// Builds the ADF document for a comment interleaving text and inline images.
// Text segments are emitted as plain paragraphs: Jira renders ADF, not markdown,
// so the body is passed through as literal text rather than being half-converted.
export function buildCommentAdf(segments: CommentSegment[]): Record<string, unknown> {
    const content: Record<string, unknown>[] = []
    for (const segment of segments) {
        if (segment.type === 'text') {
            for (const line of segment.text.split(/\n{2,}/)) {
                const trimmed = line.trim()
                if (!trimmed) continue
                content.push({
                    type: 'paragraph',
                    content: [{ type: 'text', text: trimmed }],
                })
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
    const response = await fetch(`${config.baseUrl}/rest/api/3/issue/${issueKey}/attachments`, {
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

// Resolves an attachment's Media Services UUID from the content endpoint's redirect.
export async function resolveMediaId(config: JiraConfig, attachmentId: string): Promise<string> {
    const response = await fetch(
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
    const response = await fetch(`${config.baseUrl}/rest/api/3/issue/${issueKey}/comment`, {
        method: 'POST',
        headers: {
            Authorization: authHeader(config),
            'Content-Type': 'application/json',
        },
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
    const response = await fetch(
        `${config.baseUrl}/rest/api/3/issue/${issueKey}/comment/${commentId}`,
        { method: 'DELETE', headers: { Authorization: authHeader(config) } }
    )
    // A comment that's already gone is a success for our purposes.
    if (response.status === 404) return
    await assertOk(response, `Deleting comment ${commentId}`)
}
