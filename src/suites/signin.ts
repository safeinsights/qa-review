import type { Suite } from './types'

// Smallest meaningful suite: confirms an authenticated session reaches the
// dashboard. Creates no data, so cleanup is a no-op for this suite.
export const signinSuite: Suite = {
    name: 'signin',
    description: 'Sign in and confirm the dashboard loads',
    roles: ['admin', 'researcher', 'reviewer'],
    steps: [
        {
            name: 'Confirm dashboard is visible',
            // Login already happened in the engine; just verify the landing state.
            run: ctx =>
                ctx.step(async () => {
                    await ctx.page.locator('text=dashboard').first().waitFor({ state: 'visible' })
                }),
        },
    ],
}
