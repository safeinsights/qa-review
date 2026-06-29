import type { Suite } from '@/suites/types'

// Smallest meaningful suite: confirms an authenticated session reaches the
// dashboard. Creates no data, so cleanup is a no-op for this suite.
export const signinSuite: Suite = {
    name: 'signin',
    description: 'Sign in and confirm the dashboard loads',
    roles: ['admin', 'researcher', 'reviewer'],
    async run(ctx) {
        // Login already happened in the engine; just verify the landing state.
        await ctx.step('Confirm dashboard is visible', async () => {
            await ctx.page.locator('text=dashboard').first().waitFor({ state: 'visible' })
        })
    },
}
