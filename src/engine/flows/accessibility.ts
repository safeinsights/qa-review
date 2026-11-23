import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import type { Locator, Page } from '@playwright/test'
import { expect } from '@playwright/test'
import type { RunContext, Step, Suite } from '../../suites/types'
import { waitForHydration } from './interactions'

// axe-core accessibility scans, kept out of the suite so the suite reads as a plain
// list of pages per role.
//
// axe-core is not a direct dependency: it arrives with `lighthouse`, which the app
// already ships in Resources/engine/node_modules. Resolving it here (rather than
// adding a package) means a synced clone can run this suite on an existing build.
//
// It is injected with page.evaluate, NOT addScriptTag: the app's CSP is
// nonce + 'strict-dynamic', so an inline <script> without the nonce is refused,
// whereas evaluate goes through CDP and is not subject to the page's CSP.

// WCAG 2.0/2.1/2.2 at levels A and AA — the conformance target. axe's
// "best-practice" rules are deliberately excluded: they are not conformance
// failures, and failing a step on them would make the verdict mean something else.
export const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']

export interface AxeNode {
    target: string[]
    html?: string
    failureSummary?: string
}

export interface AxeViolation {
    id: string
    impact?: string | null
    help: string
    helpUrl: string
    tags: string[]
    nodes: AxeNode[]
}

export interface PageScan {
    role: string
    route: string
    // What was on screen, for scans taken mid-flow where the path alone is ambiguous
    // (one /review URL serves the proposal, code and results stages).
    label?: string
    violations: AxeViolation[]
    // Rules axe could not decide on its own (e.g. contrast over a background image).
    // Recorded for a human to look at, never failed on.
    incomplete: { id: string; nodes: number }[]
}

let axeSource: string | undefined

// Resolved from lighthouse's own location: pnpm does not hoist transitive deps to the
// root, so a bare resolve fails in a dev checkout and finds an unlocked copy in the app.
export function loadAxeSource(): string {
    if (!axeSource) {
        const require = createRequire(import.meta.url)
        const fromLighthouse = createRequire(require.resolve('lighthouse/package.json'))
        axeSource = fs.readFileSync(fromLighthouse.resolve('axe-core/axe.min.js'), 'utf8')
    }
    return axeSource
}

// Loading spinners are replaced by real content once data arrives; scanning
// earlier audits a skeleton, which both misses real violations and varies run to run.
async function waitForSettledPage(page: Page): Promise<void> {
    await expect(page.getByRole('main')).toBeVisible()
    await waitForHydration(page)
    await expect(page.locator('main .mantine-Loader-root')).toHaveCount(0)
}

// `ready` names content that arrives AFTER hydration (a client-side fetch). Without
// it the researcher profile was scanned with every field still empty, and an
// unpopulated link failed link-name in one run and not the next.
export async function openSettled(
    ctx: RunContext,
    route: string,
    ready?: (page: Page) => Locator
): Promise<void> {
    await ctx.page.goto(`${ctx.baseURL}${route}`)
    await waitForSettledPage(ctx.page)
    if (ready) await expect(ready(ctx.page)).toBeVisible()
}

// The path actually scanned is recorded, not the one asked for: a guarded route that
// redirects (to sign-in, to the study's current stage) would otherwise be reported
// under a page that was never looked at.
export async function scanPage(
    ctx: RunContext,
    route: string,
    ready?: (page: Page) => Locator,
    opts: Omit<ScanOptions, 'route'> = {}
): Promise<PageScan> {
    await openSettled(ctx, route, ready)
    const landed = new URL(ctx.page.url()).pathname
    const requested = route.split('?')[0]
    const label = opts.label ?? (landed === requested ? undefined : `requested ${route}`)
    return scanCurrentPage(ctx, { ...opts, label })
}

export interface ScanOptions {
    label?: string
    route?: string
    // Who the page was seen as, when that is not the run's signed-in role (signed out,
    // or a user the suite created).
    as?: string
    // Drop element HTML from the report. Screens that show a password, a TOTP secret,
    // recovery codes or a private key would otherwise copy them into report.json
    // whenever an element holding one fails a rule.
    redactHtml?: boolean
}

// A Mantine modal fades in. Scanned mid-transition, its title and buttons measure
// 1.3:1 contrast against a half-drawn overlay — a failure that exists for 200ms and
// only when the scan happens to land in it. Infinite animations (spinners) are
// skipped, since they never finish.
async function waitForTransitions(page: Page): Promise<void> {
    await page.evaluate(() =>
        Promise.all(
            document
                .getAnimations()
                .filter(a => a.effect?.getTiming().iterations !== Number.POSITIVE_INFINITY)
                .map(a => a.finished.catch(() => undefined))
        )
    )
}

// Scans whatever the page shows NOW, without navigating — for a lifecycle sweep whose
// pages exist only mid-flow (a filled form, an open dialog). The caller has already
// waited on the content it cares about, so this does not wait for loaders: a page
// still polling for an analysis would otherwise never count as settled.
export async function scanCurrentPage(ctx: RunContext, opts: ScanOptions = {}): Promise<PageScan> {
    const { page } = ctx
    await waitForHydration(page)
    await waitForTransitions(page)
    await page.evaluate(loadAxeSource())
    const result = await page.evaluate(
        tags =>
            (
                window as unknown as {
                    axe: {
                        run(
                            ctx: Document,
                            opts: object
                        ): Promise<{
                            violations: AxeViolation[]
                            incomplete: AxeViolation[]
                        }>
                    }
                }
            ).axe.run(document, { runOnly: { type: 'tag', values: tags } }),
        WCAG_TAGS
    )
    return {
        role: opts.as ?? ctx.role,
        route: opts.route ?? new URL(page.url()).pathname,
        label: opts.label,
        violations: result.violations.map(v => ({
            id: v.id,
            impact: v.impact,
            help: v.help,
            helpUrl: v.helpUrl,
            tags: v.tags,
            nodes: v.nodes.map(n => ({
                target: n.target,
                html: opts.redactHtml ? undefined : n.html,
                failureSummary: n.failureSummary,
            })),
        })),
        incomplete: result.incomplete.map(v => ({ id: v.id, nodes: v.nodes.length })),
    }
}

export function describeViolations(scan: PageScan, maxTargets = 3): string {
    const lines = scan.violations.map(v => {
        const targets = v.nodes.slice(0, maxTargets).map(n => n.target.join(' '))
        const more = v.nodes.length > maxTargets ? ` (+${v.nodes.length - maxTargets} more)` : ''
        return `- ${v.id} [${v.impact ?? 'unknown'}] ${v.help}: ${targets.join(', ')}${more}`
    })
    return `${scan.violations.length} WCAG A/AA violation(s) on ${scan.label ? `${scan.label} (${scan.route})` : scan.route} as ${scan.role}:\n${lines.join('\n')}`
}

export function violationMetrics(scan: PageScan): Record<string, number> {
    return {
        violations: scan.violations.length,
        elements: scan.violations.reduce((sum, v) => sum + v.nodes.length, 0),
    }
}

export function writeReport(ctx: RunContext, scans: PageScan[]): string {
    const dir = path.join(ctx.bundleDir, 'accessibility')
    fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, 'report.json')
    fs.writeFileSync(file, JSON.stringify({ tags: WCAG_TAGS, pages: scans }, null, 2))
    return file
}

// Scans accumulate in ctx.state so the final step can judge the whole sweep.
export function recordedScans(ctx: RunContext): PageScan[] {
    if (!ctx.state.scans) ctx.state.scans = []
    return ctx.state.scans as PageScan[]
}

export function recordScan(ctx: RunContext, scan: PageScan): void {
    recordedScans(ctx).push(scan)
    ctx.recordMetrics(violationMetrics(scan))
}

// The sweep's verdict. Scan steps only record — a failed step holds the run, so
// failing per page would stop the sweep at the first bad page and hide the rest.
export const conformanceStep: Step = {
    name: 'Check WCAG conformance',
    run: ctx =>
        ctx.step(async () => {
            const all = recordedScans(ctx)
            const report = writeReport(ctx, all)
            const failing = all.filter(s => s.violations.length > 0)
            if (failing.length > 0) {
                throw new Error(
                    `${failing.length} of ${all.length} pages fail WCAG A/AA (full report: ${report})\n\n${failing.map(s => describeViolations(s)).join('\n\n')}`
                )
            }
        }),
}

// Flows call checkpoint() at screens that exist only inside one larger step — a
// signup form, an agreement modal, a toast — which a suite wrapped around the flow
// has no gap to look into. Outside an accessibility suite it is a no-op, so every
// other suite runs those flows exactly as before.
type Checkpoint = (opts: ScanOptions) => Promise<void>
let activeCheckpoint: Checkpoint | undefined

export async function checkpoint(label: string, opts: Omit<ScanOptions, 'label'> = {}) {
    if (activeCheckpoint) await activeCheckpoint({ ...opts, label })
}

// The engine calls this when a run ends, so a long-lived process does not keep
// scanning into a finished run.
export function resetCheckpoints(): void {
    activeCheckpoint = undefined
}

export const enableCheckpoints: Step = {
    name: 'Turn on accessibility checkpoints',
    run: ctx =>
        ctx.step(async () => {
            activeCheckpoint = async opts => recordScan(ctx, await scanCurrentPage(ctx, opts))
        }),
}

// Scan what the previous step left on screen. `open` navigates first, for a stage a
// flow passes through without stopping (or leaves inside one larger step); `ready`
// names what to wait for before scanning.
export function scanStep(
    label: string,
    open?: (ctx: RunContext) => Promise<void>,
    ready?: (page: Page) => Locator
): Step {
    return {
        name: `Scan: ${label}`,
        run: ctx =>
            ctx.step(async () => {
                if (open) await open(ctx)
                if (ready) await ready(ctx.page).waitFor({ state: 'visible' })
                recordScan(ctx, await scanCurrentPage(ctx, { label }))
            }),
    }
}

// Scan steps to splice into an existing suite: `steps` go after the Nth (1-based)
// step named `after`.
export interface Insert {
    after: string
    occurrence?: number
    steps: Step[]
}

// A rename in the wrapped suite fails here at load time, naming the anchor, rather
// than silently dropping a scan.
export function withInserts(base: Step[], inserts: Insert[]): Step[] {
    return inserts.reduce((steps, { after, occurrence = 1, steps: extra }) => {
        let seen = 0
        const index = steps.findIndex(s => s.name === after && ++seen === occurrence)
        if (index === -1) throw new Error(`No step #${occurrence} named "${after}" to scan after`)
        return [...steps.slice(0, index + 1), ...extra, ...steps.slice(index + 1)]
    }, base)
}

// Scan a page by URL mid-flow, labelled with what the flow is showing at that point.
export function scanRouteStep(label: string, route: (ctx: RunContext) => string): Step {
    return {
        name: `Scan: ${label}`,
        run: ctx =>
            ctx.step(async () => {
                recordScan(ctx, { ...(await scanPage(ctx, route(ctx))), label })
            }),
    }
}

// An accessibility suite made from an existing one: the base suite's own steps,
// unchanged, with `inserts` spliced in, checkpoints switched on for the screens that
// exist only inside a step (signup forms, MFA enrolment, confirm dialogs, agreement
// modals), and the verdict last — after the base suite's own cleanup has run.
export function accessibilitySweep(
    base: Suite,
    name: string,
    description: string,
    inserts: Insert[]
): Suite {
    return {
        name,
        description,
        roles: base.roles,
        steps: [enableCheckpoints, ...withInserts(base.steps, inserts), conformanceStep],
    }
}
