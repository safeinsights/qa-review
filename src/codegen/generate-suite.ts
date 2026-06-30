import type { ActionTrace, Action } from '@/codegen/action-trace'

// Escape a string for safe interpolation into a single-quoted TS string literal.
const sq = (s: string): string => s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")

function camelConst(name: string): string {
    const camel = name.replace(/[-_\s]+(.)/g, (_, c: string) => c.toUpperCase())
    const safe = /^\d/.test(camel) ? '_' + camel : camel
    return safe.charAt(0).toLowerCase() + safe.slice(1) + 'Suite'
}

function actionLine(a: Action): string {
    switch (a.kind) {
        case 'goto': {
            const url = a.url.replace(/`/g, '\\`').replace(/\$\{/g, '\\${')
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
        .map((g) => {
            const body = g.actions.map(actionLine).join('\n')
            return `        await ctx.step('${sq(g.label)}', async () => {\n${body}\n        })`
        })
        .join('\n\n')

    return `import type { Suite } from '@/suites/types'

// Generated from an exploratory run by otto codegen. Review/harden selectors
// before relying on this for regression.
export const ${camelConst(trace.name)}: Suite = {
    name: '${sq(trace.name)}',
    description: '${sq(trace.description)}',
    roles: ['${sq(trace.role)}'],
    async run(ctx) {
${stepBlocks}
    },
}
`
}
