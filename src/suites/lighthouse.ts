import { auditRoute, type RouteAudit, writeSummary } from '../engine/flows/lighthouse'
import type { RunContext, Step, Suite } from './types'

// Sweeps the app with Lighthouse and records a score per route plus an overall
// average, so performance and accessibility regressions show up as a trend instead
// of being noticed by accident.
//
// REPORT-ONLY BY DESIGN. A step fails only when the audit itself fails — never
// because a score is low. Lighthouse scores move run to run (shared QA infra, cold
// caches, a noisy CI host), so a threshold here would produce exactly the flaky red
// this repo forbids. The signal is the trend across runs, not any single number.

const ADMIN_ORG = 'openstax' // the org the shared admin account administers

// The routes audited, in run order. Each is one Step, so the GUI can show the plan
// before the run starts.
const ROUTES: { name: string; route: string }[] = [
    { name: 'Audit my dashboard', route: '/dashboard' },
    { name: 'Audit the org dashboard', route: `/${ADMIN_ORG}/dashboard` },
    { name: 'Audit admin settings', route: `/${ADMIN_ORG}/admin/settings` },
    { name: 'Audit admin team', route: `/${ADMIN_ORG}/admin/team` },
]

// Audits accumulate here across steps so the final step can average them.
function audits(ctx: RunContext): RouteAudit[] {
    if (!ctx.state.audits) ctx.state.audits = []
    return ctx.state.audits as RouteAudit[]
}

function auditStep(name: string, route: string): Step {
    return {
        name,
        run: ctx =>
            ctx.step(async () => {
                const scores = await auditRoute(ctx, route)
                audits(ctx).push({ route, scores })
                ctx.recordMetrics(scores)
            }),
    }
}

export const lighthouseSuite: Suite = {
    name: 'lighthouse',
    description: 'Audit key pages with Lighthouse and record an overall score',
    // Admin reaches every route below, including the two admin pages.
    roles: ['admin'],
    steps: [
        ...ROUTES.map(r => auditStep(r.name, r.route)),
        {
            name: 'Record the overall score',
            run: ctx =>
                ctx.step(async () => {
                    const summary = writeSummary(ctx, audits(ctx))
                    ctx.recordMetrics(summary.overall)
                }),
        },
    ],
}
