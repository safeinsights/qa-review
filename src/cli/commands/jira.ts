import fs from 'node:fs'
import {
    addCommentAdf,
    buildCommentAdf,
    type CommentSegment,
    deleteComment,
    jiraConfigFromEnv,
    resolveMediaId,
    uploadAttachment,
} from '@/engine/jira'

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

// `qar jira-comment --issue <KEY> --body-file <path> [--images a.png,b.png]`
//
// Posts ONE comment whose body embeds the given screenshots inline. Jira Cloud can
// only render an embedded image as an ADF media node keyed by a Media Services
// UUID, so each image is uploaded, its UUID resolved from the attachment-content
// redirect, and the comment posted as ADF. Prints {"id","url"} as JSON.
export async function jiraCommentCommand(opts: Record<string, string>): Promise<void> {
    const issue = opts.issue ?? ''
    if (!issue) throw new Error('jira-comment requires --issue <KEY>')
    const bodyFile = opts['body-file'] ?? ''
    if (!bodyFile && !opts.body) {
        throw new Error('jira-comment requires --body-file <path> (or --body <text>)')
    }
    const body = bodyFile ? fs.readFileSync(bodyFile, 'utf8') : (opts.body ?? '')

    const config = jiraConfigFromEnv()
    const images = splitList(opts.images)
    for (const image of images) {
        if (!fs.existsSync(image)) throw new Error(`Image not found: ${image}`)
    }

    const mediaIds: string[] = []
    for (const image of images) {
        const attachmentId = await uploadAttachment(config, issue, image)
        mediaIds.push(await resolveMediaId(config, attachmentId))
    }

    const adf = buildCommentAdf(splitBodyIntoSegments(body, mediaIds))
    const created = await addCommentAdf(config, issue, adf)
    process.stdout.write(`${JSON.stringify(created)}\n`)
}

// `qar jira-delete-comment --issue <KEY> --ids <id1,id2>` — remove comments
// (e.g. cleaning up a mis-formatted validation post). A 404 counts as done.
export async function jiraDeleteCommentCommand(opts: Record<string, string>): Promise<void> {
    const issue = opts.issue ?? ''
    if (!issue) throw new Error('jira-delete-comment requires --issue <KEY>')
    const ids = splitList(opts.ids)
    if (!ids.length) throw new Error('jira-delete-comment requires --ids <id1,id2>')

    const config = jiraConfigFromEnv()
    for (const id of ids) {
        await deleteComment(config, issue, id)
        process.stdout.write(`${JSON.stringify({ id, deleted: true })}\n`)
    }
}
