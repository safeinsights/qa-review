import fs from 'node:fs'
import path from 'node:path'
import type { RunContext } from '../../suites/types'

// Lighthouse audit mechanics, kept out of the suite so the suite reads as a plain
// list of routes.
//
// Why this exists at all, since Chrome "has Lighthouse built in": the Lighthouse
// panel in DevTools is DevTools' OWN bundled copy of the Lighthouse JS. There is no
// `Lighthouse.*` CDP domain to call and no Playwright API for it, so the only way to
// script a real audit is the npm package. What Playwright gives us is the BROWSER:
// the engine already launches Chrome with --remote-debugging-port (engine/cdp-launch
// .ts) and logs in, and lighthouse attaches to that port by number — so the audit
// runs against the same authenticated session the steps drive, not a fresh profile.

// The categories we record. Lighthouse runs more by default; pinning the list keeps
// a run's summary.json shape stable, which is what the GUI trend view plots.
export const CATEGORIES = ['performance', 'accessibility', 'best-practices', 'seo'] as const

export type CategoryId = (typeof CATEGORIES)[number]

export type Scores = Record<CategoryId, number>

export interface RouteAudit {
    route: string
    scores: Scores
}

// The per-run artifact the trend view reads back. One file per run, written by the
// suite's final step.
export interface LighthouseSummary {
    finishedAt: number
    routes: RouteAudit[]
    // Mean of each category across every audited route.
    overall: Scores
}

// Minimal shape we consume from Lighthouse's result object, so the pure helpers
// below are testable against a fixture without importing lighthouse itself.
export interface Lhr {
    categories: Record<string, { score: number | null } | undefined>
}

// Filename stem for a route's reports: "/openstax-lab/admin/settings" ->
// "openstax-lab-admin-settings". The root route has no segments, hence the fallback.
export function slugForRoute(route: string): string {
    const slug = route.replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '')
    return slug.toLowerCase() || 'root'
}

// Lighthouse reports each category as 0..1, or null when the category could not be
// computed. A null is a real failure, not a zero — scoring it 0 would silently drag
// an average down and read as "the app is terrible" rather than "the audit broke".
export function scoresFromLhr(lhr: Lhr): Scores {
    const out = {} as Scores
    for (const id of CATEGORIES) {
        const score = lhr.categories[id]?.score
        if (score === null || score === undefined) {
            throw new Error(
                `Lighthouse returned no ${id} score (the audit failed for that category)`
            )
        }
        out[id] = Math.round(score * 100)
    }
    return out
}

// Mean per category across routes, rounded. Empty input is a programming error —
// an "overall" of zero would look like a real, very bad score.
export function overallScores(routes: RouteAudit[]): Scores {
    if (routes.length === 0) throw new Error('No routes were audited, so there is no overall score')
    const out = {} as Scores
    for (const id of CATEGORIES) {
        const total = routes.reduce((sum, r) => sum + r.scores[id], 0)
        out[id] = Math.round(total / routes.length)
    }
    return out
}

function reportsDir(ctx: RunContext): string {
    return path.join(ctx.bundleDir, 'lighthouse')
}

// The port is optional on RunContext because the headed path launches without one.
// Fail here, naming the flag, rather than letting lighthouse fail to connect with a
// message that names neither this suite nor the reason.
function requireCdpPort(ctx: RunContext): number {
    if (!ctx.cdpPort) {
        throw new Error(
            'No CDP port for this run, so Lighthouse cannot attach. Run with --screencast (the GUI always does); --headed launches without a debugging port.'
        )
    }
    return ctx.cdpPort
}

// `qar sync` is a git pull and nothing else — it deliberately runs no install,
// because in the packaged app node_modules is a symlink INTO the signed .app and an
// install there would write into the bundle. So a synced clone can hold this suite
// while the app that has to run it predates the dependency.
//
// Node's own error ("Cannot find package 'lighthouse'") names the package but not
// that cause, and this repo has already paid for one stale-clone failure whose
// message named neither the app nor the staleness. So say it here.
async function loadLighthouse() {
    try {
        const mod = await import('lighthouse')
        return mod.default
    } catch (cause) {
        if ((cause as NodeJS.ErrnoException)?.code !== 'ERR_MODULE_NOT_FOUND') throw cause
        throw new Error(
            'The lighthouse package is not installed, so this suite cannot run. ' +
                'In the packaged app, syncing does NOT install dependencies — update to a ' +
                'build that ships lighthouse. In a dev checkout, run `pnpm install`.',
            { cause }
        )
    }
}

// Audit one route and write its HTML + JSON reports into the run bundle.
//
// Navigating with Playwright FIRST matters: it proves the authenticated session can
// actually reach the route, so a redirect to /signin fails as a navigation problem
// here instead of being quietly audited as a login page and reported as a fast,
// high-scoring page.
export async function auditRoute(ctx: RunContext, route: string): Promise<Scores> {
    const port = requireCdpPort(ctx)
    const url = `${ctx.baseURL}${route}`
    await ctx.page.goto(url, { waitUntil: 'domcontentloaded' })

    // Dynamic so the (large) module loads only for this suite, and so every other
    // suite keeps working if the packaged app is missing the staged tree.
    const lighthouse = await loadLighthouse()
    const result = await lighthouse(
        url,
        {
            port,
            output: ['html', 'json'],
            // Audit the page as the signed-in user. A fresh profile would bounce to
            // the sign-in page, and clearing storage would throw the session away.
            disableStorageReset: true,
        },
        // Throttling is left at Lighthouse's defaults on purpose: the trend view
        // compares runs to each other, so the settings must not drift per run.
        undefined
    )
    if (!result) throw new Error(`Lighthouse returned no result for ${route}`)

    const [html, json] = result.report as [string, string]
    const dir = reportsDir(ctx)
    fs.mkdirSync(dir, { recursive: true })
    const stem = slugForRoute(route)
    fs.writeFileSync(path.join(dir, `${stem}.report.html`), html)
    fs.writeFileSync(path.join(dir, `${stem}.report.json`), json)

    return scoresFromLhr(result.lhr as unknown as Lhr)
}

// Write the per-run summary the GUI's Performance tab reads back. The env and the
// timestamp are NOT repeated here — they are already in the bundle directory name
// (<stamp>_<suite>_<env>), which is the one place they cannot drift out of sync.
export function writeSummary(ctx: RunContext, routes: RouteAudit[]): LighthouseSummary {
    const summary: LighthouseSummary = {
        finishedAt: Date.now(),
        routes,
        overall: overallScores(routes),
    }
    const dir = reportsDir(ctx)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`)
    return summary
}
