import { SEVERITIES, type Severity } from './results'

export type { Severity }

export interface Fail {
    id: string
    severity: Severity
    area: string
}

export type FollowUpOption = 'send-back' | 'one-card' | 'multiple-cards'

const FEW = 3

function plural(n: number, word: string): string {
    return `${n} ${word}${n === 1 ? '' : 's'}`
}

// Where validation failures go is the user's call; this is the suggestion. The rule
// lives here, not in the skill text, so it is the same on every run and testable:
// a blocker means the card is not done; otherwise a handful of related fixes make
// one card and independent ones make several (what the PM asked for on OTTER-617).
export function recommendFollowUp(fails: Fail[]): { option: FollowUpOption; reason: string } {
    if (!fails.length) throw new Error('recommendFollowUp: no FAILs to route')
    // An unknown severity must not fall through as non-blocking: a typo or wrong
    // case would route a not-done card to one-card.
    for (const { id, severity } of fails) {
        if (!(SEVERITIES as readonly string[]).includes(severity)) {
            throw new Error(`recommendFollowUp: unknown severity "${severity}" on ${id}`)
        }
    }
    for (const { id, area } of fails) {
        if (typeof area !== 'string') throw new Error(`recommendFollowUp: missing area on ${id}`)
    }
    const blockers = fails.filter(f => f.severity === 'blocker').length
    if (blockers) {
        return {
            option: 'send-back',
            reason: `${plural(blockers, 'blocker')} among ${plural(fails.length, 'FAIL')} — the card is not done.`,
        }
    }
    const areas = new Set(fails.map(f => f.area.trim().toLowerCase())).size
    if (fails.length <= FEW || areas === 1) {
        return {
            option: 'one-card',
            reason: `${plural(fails.length, 'FAIL')} in ${plural(areas, 'area')}, no blockers — one card covers them.`,
        }
    }
    return {
        option: 'multiple-cards',
        reason: `${plural(fails.length, 'FAIL')} across ${plural(areas, 'area')}, no blockers — each can be fixed separately.`,
    }
}
