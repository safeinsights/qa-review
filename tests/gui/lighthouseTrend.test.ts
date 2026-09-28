import { describe, expect, it } from 'vitest'
import type { LighthouseRun } from '@/gui/lib/ipc'
import {
    buildSeries,
    type ChartGeometry,
    gridLines,
    polylinePoints,
    shortStamp,
} from '@/gui/lib/lighthouseTrend'

// Shaping for the Performance tab's chart. Scores are plotted against a FIXED 0-100
// axis, so these tests pin the pixel mapping — a fitted axis would turn a two-point
// wobble into a visual cliff and misreport a healthy app as a regression.

const GEOM: ChartGeometry = {
    width: 200,
    height: 120,
    padding: { top: 10, right: 10, bottom: 20, left: 20 },
}
// plot area: x 20..190 (width 170), y 10..100 (height 90)

function run(stamp: string, overall: Record<string, number>): LighthouseRun {
    return { bundle: `/results/${stamp}_lighthouse_qa`, stamp, env: 'qa', overall }
}

const SCORES = { performance: 50, accessibility: 100, 'best-practices': 0, seo: 75 }

describe('buildSeries', () => {
    it('maps a score of 100 to the top of the plot and 0 to the bottom', () => {
        const series = buildSeries([run('2026-09-23_120000', SCORES)], GEOM)
        const byId = Object.fromEntries(series.map(s => [s.category, s]))
        expect(byId.accessibility.points[0].y).toBe(10) // padding.top
        expect(byId['best-practices'].points[0].y).toBe(100) // top + plotHeight
        expect(byId.performance.points[0].y).toBe(55) // midpoint
    })

    it('centres a lone run instead of pinning it to the left edge', () => {
        const series = buildSeries([run('2026-09-23_120000', SCORES)], GEOM)
        expect(series[0].points[0].x).toBe(105) // left + plotWidth/2
    })

    it('spaces runs evenly across the plot width', () => {
        const runs = [
            run('2026-09-21_120000', SCORES),
            run('2026-09-22_120000', SCORES),
            run('2026-09-23_120000', SCORES),
        ]
        const xs = buildSeries(runs, GEOM)[0].points.map(p => p.x)
        expect(xs).toEqual([20, 105, 190])
    })

    it('reports the most recent score as latest', () => {
        const runs = [
            run('2026-09-21_120000', { ...SCORES, performance: 40 }),
            run('2026-09-23_120000', { ...SCORES, performance: 66 }),
        ]
        const perf = buildSeries(runs, GEOM).find(s => s.category === 'performance')
        expect(perf?.latest).toBe(66)
    })

    // A category a run never recorded must not plot as zero — that reads as a real
    // score. It simply contributes no point.
    it('skips a run that is missing a category', () => {
        const runs = [run('2026-09-21_120000', SCORES), run('2026-09-23_120000', { seo: 80 })]
        const perf = buildSeries(runs, GEOM).find(s => s.category === 'performance')
        expect(perf?.points).toHaveLength(1)
        expect(perf?.latest).toBe(50)
    })

    it('reports latest as null for a category with no history', () => {
        const series = buildSeries([run('2026-09-23_120000', { seo: 80 })], GEOM)
        const perf = series.find(s => s.category === 'performance')
        expect(perf?.latest).toBeNull()
        expect(perf?.points).toHaveLength(0)
    })

    it('returns every category even with no runs, so the legend is stable', () => {
        expect(buildSeries([], GEOM).map(s => s.category)).toEqual([
            'performance',
            'accessibility',
            'best-practices',
            'seo',
        ])
    })
})

describe('polylinePoints', () => {
    it('formats points for an SVG polyline', () => {
        expect(
            polylinePoints([
                { x: 1.25, y: 2 },
                { x: 3, y: 4.16 },
            ])
        ).toBe('1.3,2.0 3.0,4.2')
    })

    it('is empty for a series with no points', () => {
        expect(polylinePoints([])).toBe('')
    })
})

describe('gridLines', () => {
    it('spans the plot from 100 at the top to 0 at the bottom', () => {
        const lines = gridLines(GEOM)
        expect(lines.map(l => l.label)).toEqual(['100', '75', '50', '25', '0'])
        expect(lines[0].y).toBe(10)
        expect(lines[4].y).toBe(100)
    })
})

describe('shortStamp', () => {
    it('shows month and day from a bundle timestamp', () => {
        expect(shortStamp('2026-09-23_141030')).toBe('09-23')
    })

    it('passes through anything it cannot parse', () => {
        expect(shortStamp('weird')).toBe('weird')
    })
})
