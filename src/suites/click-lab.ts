import type { Suite } from '@/suites/types'

// Navigates from the personal dashboard into the research lab by clicking the
// org link in the top navigation, then confirms the lab dashboard loaded.
// Creates no data, so cleanup is a no-op for this suite.
export const clickLabSuite: Suite = {
    name: 'click-lab',
    description: 'Click the research lab nav link and confirm its dashboard loads',
    roles: ['researcher'],
    async run(ctx) {
        await ctx.step('Open the personal dashboard', async () => {
            await ctx.page.goto(`${ctx.baseURL}/dashboard`, { waitUntil: 'domcontentloaded' })
            await ctx.page.getByRole('link', { name: /Research Lab/i }).first().waitFor({ state: 'visible' })
        })

        await ctx.step('Click the research lab nav link', async () => {
            await ctx.page.getByRole('link', { name: /Research Lab/i }).first().click()
            await ctx.page.waitForURL(/\/openstax-lab\/dashboard$/)
        })
    },
}
