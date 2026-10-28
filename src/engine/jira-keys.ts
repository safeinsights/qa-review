import type { Vars } from './settings'

// The Jira boards a PR can name. Anchored to a KNOWN list, as gui/app.go does:
// management-app history is full of ticket-shaped noise ("fixes-2026", "node-7"),
// and a generic \w+-\d+ pattern turns each into a card that does not exist.
export function jiraBoardsFrom(vars: Vars): string[] {
    const raw = (vars.JIRA_BOARDS ?? '').trim()
    if (!raw) throw new Error('JIRA_BOARDS is not set in config/settings.json')
    return raw
        .split(',')
        .map(b => b.trim().toUpperCase())
        .filter(Boolean)
}

export function managementAppRepo(vars: Vars): string {
    const slug = (vars.MANAGEMENT_APP_REPO ?? '').trim()
    if (!slug) throw new Error('MANAGEMENT_APP_REPO is not set in config/settings.json')
    return slug
}

// SHRMP is a recurring typo for SHRIMP in real commits; it is matched so those PRs
// still resolve, and normalized back to the real board.
function normalize(board: string, number: string): string {
    const upper = board.toUpperCase()
    return `${upper === 'SHRMP' ? 'SHRIMP' : upper}-${number}`
}

export function extractJiraKeys(text: string, boards: string[]): string[] {
    const re = new RegExp(`\\b(${boards.join('|')})[-\\s](\\d+)\\b`, 'gi')
    const out: string[] = []
    for (const m of text.matchAll(re)) {
        const key = normalize(m[1], m[2])
        if (!out.includes(key)) out.push(key)
    }
    return out
}
