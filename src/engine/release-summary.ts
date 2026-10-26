import fs from 'node:fs'
import path from 'node:path'
import type { GhRunner } from '@/cli/commands/open-access-pr'
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

function block(summary: string): string {
    return `${OPEN}\n## What changed\n${summary.trim()}\n${CLOSE}`
}

export function spliceWithPlacement(
    body: string,
    summary: string
): { body: string; placement: Placement } {
    const b = block(summary)
    const open = body.indexOf(OPEN)
    const close = body.indexOf(CLOSE)
    if (open >= 0 && close > open) {
        return {
            body: body.slice(0, open) + b + body.slice(close + CLOSE.length),
            placement: 'replaced',
        }
    }
    const lines = body.split('\n')
    const sep = lines.indexOf(SEPARATOR)
    if (sep >= 0) {
        const before = lines.slice(0, sep).join('\n').replace(/\n+$/, '')
        const after = lines.slice(sep).join('\n')
        return { body: `${before}\n\n${b}\n\n${after}`, placement: 'inserted' }
    }
    const trimmed = body.replace(/\n+$/, '')
    return { body: trimmed ? `${trimmed}\n\n${b}\n` : `${b}\n`, placement: 'appended' }
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
