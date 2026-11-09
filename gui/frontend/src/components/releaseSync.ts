// Both the editor and the Claude session write plan.md. When Go reports a change,
// this decides what the editor does with it. Pure so it is testable without React.
export interface ReloadInput {
    incomingHash: string
    // The hash of the editor's most recent autosave; its own write comes back as an event.
    lastWrittenHash: string | null
    // The hash of the text the editor last loaded from disk.
    loadedHash: string | null
    // Keystrokes not yet autosaved.
    dirty: boolean
}

export type ReloadDecision = 'ignore' | 'reload' | 'ask'

export function decideReload(input: ReloadInput): ReloadDecision {
    if (input.incomingHash === input.lastWrittenHash) return 'ignore'
    if (input.incomingHash === input.loadedHash) return 'ignore'
    return input.dirty ? 'ask' : 'reload'
}
