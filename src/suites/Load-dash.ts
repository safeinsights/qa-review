import type { Suite } from '@/suites/types'

// Logs in as a researcher (handled by the engine before run()) and verifies the
// personal dashboard loads: the "My dashboard" heading, the welcome blurb, and
// the "My studies" table. Read-only — creates nothing, so there is no cleanup.
//
// Derived from a qa-explore trace verified live against --env qa. Note: the
// canonical dashboard route is /dashboard (NOT /researcher/dashboard, which
// 404s, despite the JWT's lastDashboardUrl metadata).
export const loadDashSuite: Suite = {
    name: 'Load-dash',
    description: 'Verify the researcher personal dashboard loads',
    roles: ['researcher'],
    async run(ctx) {
        await ctx.step('Open the personal dashboard', async () => {
            await ctx.page.goto(`${ctx.baseURL}/dashboard`, { waitUntil: 'domcontentloaded' })
            await ctx.page.getByRole('heading', { name: 'My dashboard' }).waitFor({ state: 'visible' })
        })

        await ctx.step('Verify the welcome message', async () => {
            await ctx.page.getByText(/Welcome to your personal dashboard/i).waitFor({ state: 'visible' })
        })

        await ctx.step('Verify the studies table renders', async () => {
            await ctx.page.getByRole('heading', { name: 'My studies' }).waitFor({ state: 'visible' })
        })
    },
}
