import { Button, Group, Stack, Text, Title } from '@mantine/core'
import type { LighthouseRun } from '../lib/ipc'
import {
    buildSeries,
    type ChartGeometry,
    gridLines,
    polylinePoints,
    shortStamp,
    type TrendSeries,
} from '../lib/lighthouseTrend'
import { useLighthouseHistory } from '../lib/useLighthouseHistory'

// Lighthouse scores over time. Populated by the `lighthouse` suite, which writes a
// summary.json into each run bundle; this reads them all back. Empty until that
// suite has been run at least once.

const GEOM: ChartGeometry = {
    width: 720,
    height: 260,
    padding: { top: 16, right: 16, bottom: 28, left: 34 },
}

function Legend({ series }: { series: TrendSeries[] }) {
    return (
        <Group gap="lg">
            {series.map(s => (
                <Group key={s.category} gap={6}>
                    <span
                        style={{
                            width: 10,
                            height: 10,
                            borderRadius: 2,
                            background: s.color,
                            flex: 'none',
                        }}
                    />
                    <Text size="sm">
                        {s.label} {s.latest === null ? '—' : s.latest}
                    </Text>
                </Group>
            ))}
        </Group>
    )
}

function TrendChart({ runs, series }: { runs: LighthouseRun[]; series: TrendSeries[] }) {
    const grid = gridLines(GEOM)
    const plotBottom = GEOM.height - GEOM.padding.bottom
    return (
        <svg
            width="100%"
            viewBox={`0 0 ${GEOM.width} ${GEOM.height}`}
            role="img"
            aria-label="Lighthouse scores over time"
        >
            {grid.map(line => (
                <g key={line.label}>
                    <line
                        x1={GEOM.padding.left}
                        y1={line.y}
                        x2={GEOM.width - GEOM.padding.right}
                        y2={line.y}
                        stroke="currentColor"
                        strokeOpacity={0.15}
                    />
                    <text
                        x={GEOM.padding.left - 8}
                        y={line.y + 4}
                        textAnchor="end"
                        fontSize={10}
                        fill="currentColor"
                        opacity={0.5}
                    >
                        {line.label}
                    </text>
                </g>
            ))}
            {series.map(s => (
                <g key={s.category}>
                    <polyline
                        points={polylinePoints(s.points)}
                        fill="none"
                        stroke={s.color}
                        strokeWidth={2}
                    />
                    {s.points.map(p => (
                        <circle key={`${p.x}-${p.y}`} cx={p.x} cy={p.y} r={3} fill={s.color} />
                    ))}
                </g>
            ))}
            {runs.map((run, i) => {
                const x = series[0]?.points[i]?.x
                if (x === undefined) return null
                return (
                    <text
                        key={run.bundle}
                        x={x}
                        y={plotBottom + 16}
                        textAnchor="middle"
                        fontSize={10}
                        fill="currentColor"
                        opacity={0.5}
                    >
                        {shortStamp(run.stamp)}
                    </text>
                )
            })}
        </svg>
    )
}

export function PerformanceTab() {
    const { runs, loading, error, reload } = useLighthouseHistory()
    const series = buildSeries(runs, GEOM)

    return (
        <Stack gap="md">
            <Group justify="space-between" align="center">
                <div>
                    <Title order={4}>Lighthouse scores</Title>
                    <Text size="sm" c="dimmed">
                        Overall score per run, averaged across the audited pages. Run the{' '}
                        <strong>lighthouse</strong> suite from the Testing tab to add a point.
                    </Text>
                </div>
                <Button variant="default" size="xs" onClick={reload} loading={loading}>
                    Refresh
                </Button>
            </Group>

            <PerformanceBody runs={runs} series={series} loading={loading} error={error} />
        </Stack>
    )
}

// Split out so the tab's JSX stays free of nested conditionals.
function PerformanceBody({
    runs,
    series,
    loading,
    error,
}: {
    runs: LighthouseRun[]
    series: TrendSeries[]
    loading: boolean
    error: string | null
}) {
    if (error) {
        return (
            <Text size="sm" c="red">
                Could not read past runs: {error}
            </Text>
        )
    }
    if (loading && runs.length === 0) {
        return (
            <Text size="sm" c="dimmed">
                Loading…
            </Text>
        )
    }
    if (runs.length === 0) {
        return (
            <Text size="sm" c="dimmed">
                No Lighthouse runs yet.
            </Text>
        )
    }
    return (
        <Stack gap="sm">
            <Legend series={series} />
            <TrendChart runs={runs} series={series} />
        </Stack>
    )
}
