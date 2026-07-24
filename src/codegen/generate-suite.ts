import type { Action, ActionTrace } from '@/codegen/action-trace'

// Escape a string for safe interpolation into a single-quoted TS string literal.
const sq = (s: string): string => s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")

// Escape a string for safe interpolation into a TEMPLATE literal (backticks).
// Backslash MUST be escaped first — otherwise a later backtick/${ escape would
// insert a backslash that a pre-existing input backslash could consume, letting
// the value break out of the template (CodeQL js/incomplete-sanitization).
const tq = (s: string): string =>
    s.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${')

function camelConst(name: string): string {
    const camel = name.replace(/[-_\s]+(.)/g, (_, c: string) => c.toUpperCase())
    const safe = /^\d/.test(camel) ? `_${camel}` : camel
    return `${safe.charAt(0).toLowerCase() + safe.slice(1)}Suite`
}

function actionLine(a: Action): string {
    switch (a.kind) {
        case 'goto': {
            const url = tq(a.url)
            return `            await ctx.page.goto(\`\${ctx.baseURL}${url}\`, { waitUntil: 'domcontentloaded' })`
        }
        case 'click':
            return `            await ctx.page.locator('${sq(a.selector)}').click()`
        case 'fill':
            return `            await ctx.page.locator('${sq(a.selector)}').fill('${sq(a.value)}')`
        case 'expectVisible':
            return `            await ctx.page.locator('${sq(a.selector)}').waitFor({ state: 'visible' })`
    }
}

// Group consecutive actions sharing a step label into ordered [label, actions[]].
function groupByStep(actions: Action[]): Array<{ label: string; actions: Action[] }> {
    const groups: Array<{ label: string; actions: Action[] }> = []
    for (const a of actions) {
        const last = groups[groups.length - 1]
        if (last && last.label === a.step) last.actions.push(a)
        else groups.push({ label: a.step, actions: [a] })
    }
    return groups
}

// Render an ActionTrace into TypeScript source for a Suite, matching the style of
// the hand-written suites (src/suites/*.ts). Output is reviewed via PR before use.
export function generateSuite(trace: ActionTrace): string {
    const groups = groupByStep(trace.actions)
    const stepBlocks = groups
        .map(g => {
            // actionLine emits 12-space indent; the step body here nests 8 deeper.
            const body = g.actions.map(a => `        ${actionLine(a)}`).join('\n')
            // A step declares its name once (the `name:` field). ctx.step() with no
            // name records under that name — so a single-group step drops the
            // repeated label entirely.
            return (
                `        {\n` +
                `            name: '${sq(g.label)}',\n` +
                `            run: (ctx) =>\n` +
                `                ctx.step(async () => {\n${body}\n                }),\n` +
                `        },`
            )
        })
        .join('\n')

    return `import type { Suite } from '@/suites/types'

// Generated from an exploratory run by qar codegen. Review/harden selectors
// before relying on this for regression.
export const ${camelConst(trace.name)}: Suite = {
    name: '${sq(trace.name)}',
    description: '${sq(trace.description)}',
    roles: ['${sq(trace.role)}'],
    steps: [
${stepBlocks}
    ],
}
`
}
