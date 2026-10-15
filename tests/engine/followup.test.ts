import { describe, expect, it } from 'vitest'
import { recommendFollowUp } from '@/engine/followup'

describe('recommendFollowUp', () => {
    it('sends back when any FAIL is a blocker', () => {
        const r = recommendFollowUp([
            { id: 'a', severity: 'minor', area: 'copy' },
            { id: 'b', severity: 'blocker', area: 'sorting' },
        ])
        expect(r.option).toBe('send-back')
        expect(r.reason).toMatch(/1 blocker/)
    })

    it('recommends one card for a few non-blocking FAILs', () => {
        const r = recommendFollowUp([
            { id: 'a', severity: 'minor', area: 'copy' },
            { id: 'b', severity: 'major', area: 'error state' },
        ])
        expect(r.option).toBe('one-card')
    })

    it('recommends one card when every FAIL is in the same area', () => {
        const fails = ['a', 'b', 'c', 'd'].map(id => ({
            id,
            severity: 'major' as const,
            area: 'table layout',
        }))
        expect(recommendFollowUp(fails).option).toBe('one-card')
    })

    it('recommends multiple cards for several independent FAILs', () => {
        const r = recommendFollowUp([
            { id: '3', severity: 'major', area: 'overflow' },
            { id: '4', severity: 'major', area: 'error state' },
            { id: '5', severity: 'major', area: 'pending state' },
            { id: '7', severity: 'major', area: 'last updated' },
            { id: '8', severity: 'minor', area: 'link component' },
        ])
        expect(r.option).toBe('multiple-cards')
        expect(r.reason).toMatch(/5 FAILs.*4 areas|5 FAILs.*5 areas/)
    })

    it('rejects an empty list', () => {
        expect(() => recommendFollowUp([])).toThrow('no FAILs')
    })
})
