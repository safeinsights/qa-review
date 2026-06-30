import type { Suite, RunContext } from '@/suites/types'

// Read-only suite: from the researcher dashboard, find the first study whose
// status is "Code draft", open it (its View link lands on the /code step), then
// click "Previous" to reach the Agreements step (STEP 3) and verify the
// "Data use agreement" and "IRB protocol" sections are shown.
//
// Creates nothing, so there is nothing to track or clean up. Selectors are kept
// stable: the Code-draft row is located by its Status cell text rather than a
// hard-coded study name, so the suite survives test-data churn.
export const agreementsBackSuite: Suite = {
    name: 'agreements-back',
    description:
        'View a Code-draft study, go Back to the Agreements step, and verify the Data use agreement and IRB protocol sections render',
    roles: ['researcher'],
    async run(ctx) {
        await ctx.step('Open the dashboard and confirm it loaded', async () => {
            await ctx.page.goto(`${ctx.baseURL}/dashboard`, { waitUntil: 'domcontentloaded' })
            await ctx.page.getByRole('heading', { name: 'My dashboard' }).waitFor({ state: 'visible' })
            await ctx.page.getByRole('heading', { name: 'My studies' }).waitFor({ state: 'visible' })
        })

        await ctx.step('Find a Code-draft study and view it', async () => {
            // Each study is a row; locate the first one whose Status cell reads
            // "Code draft", then click its "View details" link.
            const row = ctx.page
                .getByRole('row')
                .filter({ hasText: 'Code draft' })
                .first()
            await row.waitFor({ state: 'visible' })
            await row.getByRole('link', { name: /^View details for study/i }).click()
            // The Code-draft "View" link goes to the /code step of the study flow.
            await ctx.page.waitForURL(/\/study\/[0-9a-f-]+\/code$/i)
            await ctx.page.getByRole('heading', { name: 'Study code' }).waitFor({ state: 'visible' })
        })

        await ctx.step('Click Previous to reach the Agreements step', async () => {
            await ctx.page.getByRole('link', { name: 'Previous' }).click()
            await ctx.page.waitForURL(/\/study\/[0-9a-f-]+\/agreements\/researcher$/i)
        })

        await ctx.step('Verify the Data use agreement and IRB protocol sections are shown', async () => {
            await ctx.page.getByRole('heading', { name: 'Study request' }).waitFor({ state: 'visible' })
            await ctx.page.getByRole('heading', { name: 'Data use agreement' }).waitFor({ state: 'visible' })
            await ctx.page.getByRole('heading', { name: 'IRB protocol' }).waitFor({ state: 'visible' })
        })
    },
}
