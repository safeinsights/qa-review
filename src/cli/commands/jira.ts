import fs from 'node:fs'
import path from 'node:path'
import {
    addCommentAdf,
    attachmentsLine,
    attachmentUrl,
    buildCommentAdf,
    type CommentSegment,
    deleteAttachment,
    deleteComment,
    downloadAttachment,
    isTextAttachment,
    jiraConfig,
    listAttachments,
    resolveMediaId,
    uploadAttachment,
} from '@/engine/jira'
import { repoDir } from '@/engine/paths'
import type { Vars } from '@/engine/settings'
import { toolVersion, versionLine } from '@/engine/version'

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

// Uploads go to a card anyone can read, and `qar` runs unprompted, so a prompt-injected
// "attach config/age-identity.txt" must not work: only files under <repo>/.tmp/ (the
// session scratch dir) may be uploaded. realpath defeats `..` and symlinks.
export function assertUploadable(file: string): void {
    if (!fs.existsSync(file)) throw new Error(`File not found: ${file}`)
    const scratch = fs.realpathSync(path.join(repoDir(), '.tmp'))
    const real = fs.realpathSync(file)
    if (!real.startsWith(`${scratch}${path.sep}`)) {
        throw new Error(`Refusing to upload ${file}: only files under ${scratch} may be uploaded.`)
    }
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
    for (const file of [...images, ...attachments]) assertUploadable(file)
    // A bare `--mention` parses to 'true'. Reject it before any upload, which a
    // rejected body would leave behind as orphan attachments.
    const mention = (opts.mention ?? '').trim() || undefined
    if (mention === 'true') throw new Error('jira-comment: --mention needs an account id')

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
    // Every comment ends with the version of this tool, so a reader can tell which
    // build of the validator wrote it.
    const footer = [attachmentsLine(uploaded), `_${versionLine(toolVersion())}_`]
        .filter(Boolean)
        .join('\n')
    const adf = buildCommentAdf(splitBodyIntoSegments(body, mediaIds), {
        mention,
        footer,
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

// `qar jira-delete-attachment --issue <KEY> --ids <id1,id2>` — remove attachments,
// typically the uploads a deleted comment left behind (deleting a comment does not
// delete its files). Jira's endpoint takes the id alone, so a mistyped id would delete
// a file on some OTHER card; every id is therefore checked against this card's list
// first, and one that is not on it is reported and left alone. Re-running is harmless:
// an id already deleted is simply no longer on the card.
export async function jiraDeleteAttachmentCommand(
    opts: Record<string, string>,
    vars: Vars
): Promise<void> {
    const issue = opts.issue ?? ''
    if (!issue) throw new Error('jira-delete-attachment requires --issue <KEY>')
    const ids = splitList(opts.ids)
    if (!ids.length) throw new Error('jira-delete-attachment requires --ids <id1,id2>')

    const config = jiraConfig(vars)
    const onCard = new Map((await listAttachments(config, issue)).map(a => [a.id, a.filename]))
    for (const id of ids) {
        const filename = onCard.get(id)
        if (filename === undefined) {
            const note = `not attached to ${issue} (already deleted, or on another card)`
            process.stdout.write(`${JSON.stringify({ id, deleted: false, note })}\n`)
            continue
        }
        await deleteAttachment(config, id)
        process.stdout.write(`${JSON.stringify({ id, filename, deleted: true })}\n`)
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
