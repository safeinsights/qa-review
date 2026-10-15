export type Severity = 'blocker' | 'major' | 'minor'

export interface Fail {
    id: string
    severity: Severity
    area: string
}

export type FollowUpOption = 'send-back' | 'one-card' | 'multiple-cards'

const FEW = 3

// Where validation failures go is the user's call; this is the suggestion. The rule
// lives here, not in the skill text, so it is the same on every run and testable:
// a blocker means the card is not done; otherwise a handful of related fixes make
// one card and independent ones make several (what the PM asked for on OTTER-617).
export function recommendFollowUp(fails: Fail[]): { option: FollowUpOption; reason: string } {
    if (!fails.length) throw new Error('recommendFollowUp: no FAILs to route')
    const blockers = fails.filter(f => f.severity === 'blocker').length
    if (blockers) {
        return {
            option: 'send-back',
            reason: `${blockers} blocker${blockers === 1 ? '' : 's'} among ${fails.length} FAILs — the card is not done.`,
        }
    }
    const areas = new Set(fails.map(f => f.area.trim().toLowerCase())).size
    if (fails.length <= FEW || areas === 1) {
        return {
            option: 'one-card',
            reason: `${fails.length} FAILs in ${areas} area${areas === 1 ? '' : 's'}, no blockers — one card covers them.`,
        }
    }
    return {
        option: 'multiple-cards',
        reason: `${fails.length} FAILs across ${areas} areas, no blockers — each can be fixed separately.`,
    }
}
