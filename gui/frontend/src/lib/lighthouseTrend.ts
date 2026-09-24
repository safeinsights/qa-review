import type { LighthouseRun } from './ipc'

// Shaping for the Performance tab's trend chart. Kept in a plain .ts module (not
// inside the .tsx) so it can be unit-tested — the engine tsconfig sets no --jsx,
// which is the same reason validationInputs.ts exists separately from ValidationTab.

// The categories plotted, in legend order. Fixed rather than derived from the data
// so the colour of a line never changes as runs come and go.
export const TREND_CATEGORIES = ['performance', 'accessibility', 'best-practices', 'seo'] as const

export type TrendCategory = (typeof TREND_CATEGORIES)[number]

export const CATEGORY_LABELS: Record<TrendCategory, string> = {
    performance: 'Performance',
    accessibility: 'Accessibility',
    'best-practices': 'Best practices',
    seo: 'SEO',
}

// Distinct in both themes; not Mantine-theme-dependent, so the chart reads the same
// wherever it renders.
export const CATEGORY_COLORS: Record<TrendCategory, string> = {
    performance: '#4dabf7',
    accessibility: '#51cf66',
    'best-practices': '#ffd43b',
    seo: '#e599f7',
}

export interface TrendPoint {
    x: number
    y: number
}

export interface TrendSeries {
    category: TrendCategory
    label: string
    color: string
    points: TrendPoint[]
    // The most recent score, shown in the legend. Null when no run recorded this
    // category — a category added later has no history before its first run.
    latest: number | null
}

export interface ChartGeometry {
    width: number
    height: number
    padding: { top: number; right: number; bottom: number; left: number }
}

// Scores are always 0-100, so the y-axis is fixed rather than fitted to the data.
// A fitted axis would silently exaggerate a two-point wobble into a cliff.
const Y_MIN = 0
const Y_MAX = 100

// Map runs to pixel-space series. Runs are assumed oldest-first (the Go side sorts
// them), so the x position is just the index — spacing is by run, not by elapsed
// time, which keeps a burst of runs from crushing the older ones into the margin.
export function buildSeries(runs: LighthouseRun[], geom: ChartGeometry): TrendSeries[] {
    const { width, height, padding } = geom
    const plotWidth = width - padding.left - padding.right
    const plotHeight = height - padding.top - padding.bottom
    // A single run has no span to divide by; centring it reads better than pinning
    // it to the left edge.
    const stepX = runs.length > 1 ? plotWidth / (runs.length - 1) : 0
    const originX = runs.length > 1 ? padding.left : padding.left + plotWidth / 2

    return TREND_CATEGORIES.map(category => {
        const points: TrendPoint[] = []
        let latest: number | null = null
        runs.forEach((run, i) => {
            const score = run.overall[category]
            if (typeof score !== 'number') return
            latest = score
            const ratio = (score - Y_MIN) / (Y_MAX - Y_MIN)
            points.push({
                x: originX + stepX * i,
                y: padding.top + plotHeight - ratio * plotHeight,
            })
        })
        return {
            category,
            label: CATEGORY_LABELS[category],
            color: CATEGORY_COLORS[category],
            points,
            latest,
        }
    })
}

// SVG polyline "points" attribute for a series.
export function polylinePoints(points: TrendPoint[]): string {
    return points.map(p => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ')
}

// Horizontal gridlines at 0/25/50/75/100, as y pixel positions with their labels.
export function gridLines(geom: ChartGeometry): { y: number; label: string }[] {
    const plotHeight = geom.height - geom.padding.top - geom.padding.bottom
    return [100, 75, 50, 25, 0].map(value => ({
        y: geom.padding.top + plotHeight - (value / Y_MAX) * plotHeight,
        label: String(value),
    }))
}

// "2026-09-23_141030" -> "09-23". The axis has room for a few runs' worth of
// labels, so it shows the date without the year or the seconds.
export function shortStamp(stamp: string): string {
    const [date] = stamp.split('_')
    const parts = (date ?? '').split('-')
    if (parts.length !== 3) return stamp
    return `${parts[1]}-${parts[2]}`
}
