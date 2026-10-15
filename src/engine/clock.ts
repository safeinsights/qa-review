// Wall-clock marks for one validation. The session marks the end of each phase and
// the report quotes the totals; the arithmetic lives here so it is never done by hand.

export interface Mark {
    phase: string
    at: string
}

export function addMark(marks: Mark[], phase: string, now: number = Date.now()): Mark[] {
    const name = phase.trim()
    if (!name) throw new Error('clock: a mark needs a phase name')
    return [...marks, { phase: name, at: new Date(now).toISOString() }]
}

export function formatDuration(ms: number): string {
    const minutes = Math.round(ms / 60_000)
    if (minutes < 1) return '< 1 min'
    if (minutes < 60) return `${minutes} min`
    return `${Math.floor(minutes / 60)} h ${minutes % 60} min`
}

// Each phase is named by the mark that ENDS it, so `start → inventory` reads as
// "inventory 14 min". When the last mark is not the end of the run (the report is
// written before the `posted` mark), the open phase runs to `now`.
export function formatClock(marks: Mark[], now?: number): string {
    if (marks.length === 0) throw new Error('clock: no marks')
    const times = marks.map(m => ({ phase: m.phase, at: Date.parse(m.at) }))
    if (now !== undefined && now > times[times.length - 1].at) {
        times.push({ phase: '(now)', at: now })
    }
    const parts = times.slice(1).map((t, i) => `${t.phase} ${formatDuration(t.at - times[i].at)}`)
    const total = formatDuration(times[times.length - 1].at - times[0].at)
    return [`Total ${total}`, ...parts].join(' · ')
}
