import fs from 'node:fs'
import path from 'node:path'
import type { GhRunner } from '@/cli/commands/open-access-pr'
import { hasSecurityContent } from './public-plan'
import { releaseDir } from './release-paths'

const OPEN = '<!-- regression-summary -->'
const CLOSE = '<!-- /regression-summary -->'
// The generated release notes put exactly this line between "Related Releases"
// and the PR table; the summary goes right above it.
const SEPARATOR = '------'

export function extractSummary(plan: string): string {
    const lines = plan.split(/\r?\n/)
    const start = lines.findIndex(l => /^## Summary\s*$/.test(l))
    if (start < 0) throw new Error('the plan has no "## Summary" section')
    let end = lines.length
    for (let i = start + 1; i < lines.length; i++) {
        if (/^## /.test(lines[i])) {
            end = i
            break
        }
    }
    const text = lines
        .slice(start + 1, end)
        .join('\n')
        .trim()
    if (!text) throw new Error('the "## Summary" section is empty')
    return text
}

export type Placement = 'replaced' | 'inserted' | 'appended'

function block(summary: string, eol: string): string {
    const text = summary.trim().replace(/\r?\n/g, eol)
    return [OPEN, '## What changed', text, CLOSE].join(eol)
}

const UNMATCHED =
    'the release description has an unmatched regression-summary marker; fix it on GitHub first'

export function spliceWithPlacement(
    body: string,
    summary: string
): { body: string; placement: Placement } {
    // GitHub bodies edited in the web UI use CRLF; mixing endings would corrupt them.
    const eol = body.includes('\r\n') ? '\r\n' : '\n'
    const b = block(summary, eol)
    const close = body.indexOf(CLOSE)
    // lastIndexOf: a stray open marker earlier in the text must not widen the span
    // that gets replaced, or the content between it and the pair would be deleted.
    const open = close >= 0 ? body.lastIndexOf(OPEN, close) : -1
    const hasMarkers = body.includes(OPEN) || close >= 0
    if (hasMarkers && (open < 0 || close < 0)) throw new Error(UNMATCHED)
    if (open >= 0) {
        return {
            body: body.slice(0, open) + b + body.slice(close + CLOSE.length),
            placement: 'replaced',
        }
    }
    const lines = body.split(/\r?\n/)
    const sep = lines.findIndex(l => l.trimEnd() === SEPARATOR)
    if (sep >= 0) {
        const before = lines
            .slice(0, sep)
            .join(eol)
            .replace(/(\r?\n)+$/, '')
        const after = lines.slice(sep).join(eol)
        return { body: `${before}${eol}${eol}${b}${eol}${eol}${after}`, placement: 'inserted' }
    }
    const trimmed = body.replace(/(\r?\n)+$/, '')
    return {
        body: trimmed ? `${trimmed}${eol}${eol}${b}${eol}` : `${b}${eol}`,
        placement: 'appended',
    }
}

export function spliceSummary(body: string, summary: string): string {
    return spliceWithPlacement(body, summary).body
}

export async function updateReleaseSummary(
    gh: GhRunner,
    repo: string,
    tag: string,
    summary: string
): Promise<Placement> {
    // The release description is as public as the assets, and the Summary is free
    // text the session writes: it can quote an S- line.
    if (hasSecurityContent(summary)) {
        throw new Error(
            'refusing to publish the summary: it contains security content; management-app is public'
        )
    }
    const raw = await gh(['api', `repos/${repo}/releases/tags/${tag}`, '--jq', '.body'])
    // --jq prints the string with a trailing newline that is not part of the body,
    // and prints the bare word "null" for a release with no description.
    const body = raw.replace(/\n$/, '')
    const { body: next, placement } = spliceWithPlacement(body === 'null' ? '' : body, summary)
    const dir = releaseDir(tag)
    fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, 'release-notes.md')
    fs.writeFileSync(file, next)
    await gh(['release', 'edit', tag, '--repo', repo, '--notes-file', file])
    return placement
}
