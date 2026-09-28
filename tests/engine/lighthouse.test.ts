import { describe, expect, it } from 'vitest'
import {
    type Lhr,
    overallScores,
    type RouteAudit,
    type Scores,
    scoresFromLhr,
    slugForRoute,
} from '@/engine/flows/lighthouse'

// The pure halves of the lighthouse flow. The audit itself drives a real browser
// and a real Lighthouse run, so it is exercised end-to-end by running the suite,
// not mocked here.

function lhr(scores: Record<string, number | null>): Lhr {
    const categories: Lhr['categories'] = {}
    for (const [id, score] of Object.entries(scores)) categories[id] = { score }
    return { categories }
}

const ALL_GOOD = {
    performance: 0.62,
    accessibility: 0.94,
    'best-practices': 0.83,
    seo: 0.9,
}

describe('slugForRoute', () => {
    it('flattens a path into a filename stem', () => {
        expect(slugForRoute('/openstax/admin/settings')).toBe('openstax-admin-settings')
        expect(slugForRoute('/dashboard')).toBe('dashboard')
    })

    it('names the root route rather than producing an empty filename', () => {
        expect(slugForRoute('/')).toBe('root')
        expect(slugForRoute('')).toBe('root')
    })

    it('collapses characters that are not filename-safe', () => {
        expect(slugForRoute('/study/abc123/review?tab=code')).toBe('study-abc123-review-tab-code')
    })
})

describe('scoresFromLhr', () => {
    it('converts lighthouse 0..1 scores to 0-100 integers', () => {
        expect(scoresFromLhr(lhr(ALL_GOOD))).toEqual({
            performance: 62,
            accessibility: 94,
            'best-practices': 83,
            seo: 90,
        })
    })

    it('rounds rather than truncating', () => {
        expect(scoresFromLhr(lhr({ ...ALL_GOOD, performance: 0.615 })).performance).toBe(62)
        expect(scoresFromLhr(lhr({ ...ALL_GOOD, performance: 0.614 })).performance).toBe(61)
    })

    // A null score means the category could not be computed. Recording it as 0
    // would look like a real (terrible) score and quietly drag the average down.
    it('throws on a null category instead of scoring it zero', () => {
        expect(() => scoresFromLhr(lhr({ ...ALL_GOOD, performance: null }))).toThrow(/performance/)
    })

    it('throws when a category is missing entirely', () => {
        const partial = { ...ALL_GOOD } as Record<string, number>
        delete partial.seo
        expect(() => scoresFromLhr(lhr(partial))).toThrow(/seo/)
    })
})

describe('overallScores', () => {
    const scores = (n: number): Scores => ({
        performance: n,
        accessibility: n,
        'best-practices': n,
        seo: n,
    })

    it('averages each category across routes', () => {
        const routes: RouteAudit[] = [
            { route: '/a', scores: scores(60) },
            { route: '/b', scores: scores(80) },
        ]
        expect(overallScores(routes)).toEqual(scores(70))
    })

    it('averages each category independently', () => {
        const routes: RouteAudit[] = [
            {
                route: '/a',
                scores: { performance: 50, accessibility: 90, 'best-practices': 70, seo: 100 },
            },
            {
                route: '/b',
                scores: { performance: 70, accessibility: 100, 'best-practices': 80, seo: 90 },
            },
        ]
        expect(overallScores(routes)).toEqual({
            performance: 60,
            accessibility: 95,
            'best-practices': 75,
            seo: 95,
        })
    })

    it('rounds the mean', () => {
        const routes: RouteAudit[] = [
            { route: '/a', scores: scores(60) },
            { route: '/b', scores: scores(61) },
        ]
        expect(overallScores(routes).performance).toBe(61)
    })

    // An "overall" of 0 from an empty run would plot as a real score on the trend
    // chart, which is worse than no point at all.
    it('throws when nothing was audited', () => {
        expect(() => overallScores([])).toThrow(/no overall score/i)
    })
})
