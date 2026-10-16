import { describe, expect, it } from 'vitest'
import { addMark, formatClock, formatDuration, type Mark } from '@/engine/clock'

const T0 = Date.parse('2026-10-15T10:00:00Z')
const min = (n: number) => n * 60_000

describe('formatDuration', () => {
    it('rounds to minutes, with hours when needed', () => {
        expect(formatDuration(min(0.4))).toBe('< 1 min')
        expect(formatDuration(min(14))).toBe('14 min')
        expect(formatDuration(min(72))).toBe('1 h 12 min')
        expect(formatDuration(min(120))).toBe('2 h 0 min')
    })
})

describe('addMark', () => {
    it('appends a mark with the time it was taken', () => {
        const marks = addMark([], 'start', T0)
        expect(marks).toEqual([{ phase: 'start', at: '2026-10-15T10:00:00.000Z' }])
    })

    it('rejects an empty phase name', () => {
        expect(() => addMark([], '  ', T0)).toThrow('phase')
    })
})

describe('formatClock', () => {
    const marks: Mark[] = [
        { phase: 'start', at: new Date(T0).toISOString() },
        { phase: 'inventory', at: new Date(T0 + min(14)).toISOString() },
        { phase: 'approved', at: new Date(T0 + min(20)).toISOString() },
        { phase: 'tested', at: new Date(T0 + min(71)).toISOString() },
        { phase: 'posted', at: new Date(T0 + min(78)).toISOString() },
    ]

    it('reports the total and each phase, named by the mark that ends it', () => {
        expect(formatClock(marks)).toBe(
            'Total 1 h 18 min · inventory 14 min · approved 6 min · tested 51 min · posted 7 min'
        )
    })

    it('runs the open phase to now when the last mark is not the end', () => {
        expect(formatClock(marks.slice(0, 2), T0 + min(30))).toBe(
            'Total 30 min · inventory 14 min · (now) 16 min'
        )
    })

    it('stops at the posted mark even when now is later', () => {
        expect(formatClock(marks, T0 + min(600))).toBe(
            'Total 1 h 18 min · inventory 14 min · approved 6 min · tested 51 min · posted 7 min'
        )
    })

    it('needs at least one mark', () => {
        expect(() => formatClock([])).toThrow('no marks')
    })
})
