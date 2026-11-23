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

// SHRMP is the real board key; PR text often spells it out as SHRIMP, so that is
// matched too and normalized back to SHRMP. Every key that reaches Jira goes through
// here, so a write never targets a SHRIMP-n issue that does not exist.
function normalize(board: string, number: string): string {
    const upper = board.toUpperCase()
    return `${upper === 'SHRIMP' ? 'SHRMP' : upper}-${number}`
}

export function normalizeJiraKey(key: string): string {
    const dash = key.lastIndexOf('-')
    return dash < 0 ? key : normalize(key.slice(0, dash), key.slice(dash + 1))
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
