import fs from 'node:fs'
import path from 'node:path'
import {
    addCommentAdf,
    attachmentsLine,
    attachmentUrl,
    buildCommentAdf,
    type CommentSegment,
    deleteComment,
    downloadAttachment,
    isTextAttachment,
    jiraConfig,
    listAttachments,
    resolveMediaId,
    uploadAttachment,
} from '@/engine/jira'
import type { Vars } from '@/engine/settings'

// Splits a body into ordered text/media segments on `{{image:N}}` placeholders,
// where N is a 1-based index into the supplied image list. Images that are never
// referenced by a placeholder are appended, in order, after the body — so the
// common "verdict then screenshots" case needs no placeholders at all.
export function splitBodyIntoSegments(body: string, mediaIds: string[]): CommentSegment[] {
    const segments: CommentSegment[] = []
    const used = new Set<number>()
    let cursor = 0
    const placeholder = /\{\{image:(\d+)\}\}/g
    let match = placeholder.exec(body)
    while (match) {
        const index = Number(match[1]) - 1
        const mediaId = mediaIds[index]
        if (mediaId) {
            const before = body.slice(cursor, match.index)
            if (before.trim()) segments.push({ type: 'text', text: before })
            segments.push({ type: 'media', mediaId })
            used.add(index)
            cursor = match.index + match[0].length
        }
        match = placeholder.exec(body)
    }
    const rest = body.slice(cursor)
    if (rest.trim()) segments.push({ type: 'text', text: rest })
    mediaIds.forEach((mediaId, index) => {
        if (!used.has(index)) segments.push({ type: 'media', mediaId })
    })
    return segments
}

function splitList(value: string | undefined): string[] {
    return (value ?? '')
        .split(',')
        .map(entry => entry.trim())
        .filter(Boolean)
}

// `qar jira-comment --issue <KEY> --body-file <path> [--images a.png,b.png] [--attach a.html,b.json]`
//
// Posts ONE comment whose body embeds the given screenshots inline. `--attach`
// uploads other files (the inventory page, the results JSON) and appends a line
// linking them, so the evidence a verdict rests on travels with the card. Jira Cloud can
// only render an embedded image as an ADF media node keyed by a Media Services
// UUID, so each image is uploaded, its UUID resolved from the attachment-content
// redirect, and the comment posted as ADF. Prints {"id","url"} as JSON.
export async function jiraCommentCommand(opts: Record<string, string>, vars: Vars): Promise<void> {
    const issue = opts.issue ?? ''
    if (!issue) throw new Error('jira-comment requires --issue <KEY>')
    const bodyFile = opts['body-file'] ?? ''
    if (!bodyFile && !opts.body) {
        throw new Error('jira-comment requires --body-file <path> (or --body <text>)')
    }
    const body = bodyFile ? fs.readFileSync(bodyFile, 'utf8') : (opts.body ?? '')

    const config = jiraConfig(vars)
    const images = splitList(opts.images)
    const attachments = splitList(opts.attach)
    for (const file of [...images, ...attachments]) {
        if (!fs.existsSync(file)) throw new Error(`File not found: ${file}`)
    }

    const mediaIds: string[] = []
    for (const image of images) {
        const attachmentId = await uploadAttachment(config, issue, image)
        mediaIds.push(await resolveMediaId(config, attachmentId))
    }

    const uploaded = []
    for (const file of attachments) {
        const id = await uploadAttachment(config, issue, file)
        uploaded.push({ filename: path.basename(file), url: attachmentUrl(config, id) })
    }
    const line = attachmentsLine(uploaded)
    const fullBody = line ? `${body.trimEnd()}\n\n${line}\n` : body

    const adf = buildCommentAdf(splitBodyIntoSegments(fullBody, mediaIds), {
        mention: opts.mention || undefined,
    })
    const created = await addCommentAdf(config, issue, adf)
    process.stdout.write(`${JSON.stringify(created)}\n`)
}

// `qar jira-delete-comment --issue <KEY> --ids <id1,id2>` — remove comments
// (e.g. cleaning up a mis-formatted validation post). A 404 counts as done.
export async function jiraDeleteCommentCommand(
    opts: Record<string, string>,
    vars: Vars
): Promise<void> {
    const issue = opts.issue ?? ''
    if (!issue) throw new Error('jira-delete-comment requires --issue <KEY>')
    const ids = splitList(opts.ids)
    if (!ids.length) throw new Error('jira-delete-comment requires --ids <id1,id2>')

    const config = jiraConfig(vars)
    for (const id of ids) {
        await deleteComment(config, issue, id)
        process.stdout.write(`${JSON.stringify({ id, deleted: true })}\n`)
    }
}

const MAX_TEXT_ATTACHMENT_BYTES = 2 * 1024 * 1024

// Jira allows many attachments with one filename, so the id keeps saved paths unique.
// A name that basename reduces to '', '.' or '..' would resolve to a directory.
function savedName(attachment: { id: string; filename: string }): string {
    const name = path.basename(attachment.filename)
    if (name === '' || name === '.' || name === '..') {
        return `${attachment.id}${path.extname(attachment.filename)}`
    }
    return `${attachment.id}-${name}`
}

// `qar jira-attachments --issue <KEY> [--download] [--dir <path>]`
//
// Lists a card's attachments as JSON lines; with --download, saves the TEXT ones
// (test plans, CSVs) under --dir (default .tmp/<KEY>-attachments) so the validator
// can read them. Images are listed only.
export async function jiraAttachmentsCommand(
    opts: Record<string, string>,
    vars: Vars
): Promise<void> {
    const issue = opts.issue ?? ''
    if (!issue) throw new Error('jira-attachments requires --issue <KEY>')
    const config = jiraConfig(vars)
    const download = opts.download === 'true'
    const dir = opts.dir || path.join('.tmp', `${issue}-attachments`)

    for (const attachment of await listAttachments(config, issue)) {
        const row: Record<string, unknown> = { ...attachment }
        if (download && isTextAttachment(attachment)) {
            if (attachment.size > MAX_TEXT_ATTACHMENT_BYTES) {
                row.skipped = 'larger than 2 MB'
            } else {
                const dest = path.join(dir, savedName(attachment))
                await downloadAttachment(config, attachment.id, dest)
                row.saved = dest
            }
        }
        process.stdout.write(`${JSON.stringify(row)}\n`)
    }
}
