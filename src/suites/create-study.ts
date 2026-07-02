import type { RunContext, Suite } from '@/suites/types'

// Creates a study as a researcher, captures its id for guaranteed cleanup, and
// submits the initial proposal. Selectors mirror the management-app e2e
// study-flow spec and were verified live against a PR preview.
//
// The study record is created as soon as Step 2 (the proposal page) loads — its
// id is in the URL: /<org>/study/<studyId>/proposal — so we capture and track it
// there, before any later step can fail, ensuring cleanup always targets it.
export const createStudySuite: Suite = {
    name: 'create-study',
    description: 'Create a study as a researcher, submit it, then clean it up',
    roles: ['researcher'],
    steps: [
        {
            name: 'Open the researcher org dashboard',
            run: async ctx => {
                await ctx.step('Open the researcher org dashboard', async () => {
                    await ctx.page.goto(`${ctx.baseURL}/openstax-lab/dashboard`, {
                        waitUntil: 'domcontentloaded',
                    })
                    await ctx.page
                        .getByRole('link', { name: /Propose New Study/i })
                        .first()
                        .waitFor({ state: 'visible' })
                })
            },
        },
        {
            name: 'Start a new study proposal',
            run: async ctx => {
                await ctx.step('Start a new study proposal', async () => {
                    await ctx.page
                        .getByRole('link', { name: /Propose New Study/i })
                        .first()
                        .click()
                    await ctx.page.waitForURL(/\/study\/request$/)
                })
            },
        },
        {
            name: 'Step 1: choose org and language',
            run: async ctx => {
                await ctx.step('Step 1: choose org and language', async () => {
                    const orgSelect = ctx.page.getByTestId('org-select')
                    await orgSelect.click()
                    await ctx.page
                        .getByRole('option', { name: /openstax/i })
                        .first()
                        .click()
                    const rRadio = ctx.page.getByRole('radio', { name: 'R', exact: true })
                    await rRadio.waitFor({ state: 'visible' })
                    await rRadio.click()
                    await ctx.page.getByRole('button', { name: /Proceed to Step 2/i }).click()
                })
            },
        },
        {
            name: 'Reach Step 2 and capture the study id',
            run: async ctx => {
                const studyId = await ctx.step(
                    'Reach Step 2 and capture the study id',
                    async () => {
                        await ctx.page.waitForURL(/\/study\/[0-9a-f-]+\/proposal$/i)
                        const match = ctx.page.url().match(/\/study\/([0-9a-f-]+)\/proposal/i)
                        if (!match)
                            throw new Error(
                                `Could not find study id in proposal URL: ${ctx.page.url()}`
                            )
                        return match[1]
                    }
                )
                // Register for guaranteed cleanup BEFORE filling/submitting — the
                // study record already exists at this point. Stash the id so later
                // steps (and cleanup) can reach it.
                ctx.state.studyId = studyId
                ctx.trackStudy(studyId)
            },
        },
        {
            name: 'Step 2: fill the proposal',
            run: async ctx => {
                await ctx.step('Step 2: fill the proposal', async () => {
                    const title = `QA Test Study ${ctx.tag}`
                    await ctx.page.getByLabel('Study Title').fill(title)
                    await ctx.page.getByPlaceholder('Select dataset(s) of interest').click()
                    await ctx.page.getByRole('option').first().click()
                    await fillLexical(
                        ctx,
                        'Research question(s)',
                        'What is the impact of highlighting on student outcomes?'
                    )
                    await fillLexical(
                        ctx,
                        'Project summary',
                        'We analyze archival data to study highlighting behavior.'
                    )
                    await fillLexical(
                        ctx,
                        'Impact',
                        'This research will improve understanding of study habits.'
                    )
                    const pi = ctx.page.getByRole('textbox', { name: 'Principal Investigator' })
                    await pi.click()
                    await ctx.page.getByRole('option').first().click()
                })
            },
        },
        {
            name: 'Submit the initial request',
            run: async ctx => {
                await ctx.step('Submit the initial request', async () => {
                    await ctx.page.getByRole('button', { name: /Submit initial request/i }).click()
                    await ctx.page
                        .getByRole('button', { name: /Yes, submit initial request/i })
                        .click()
                    await ctx.page
                        .getByText(/successfully submitted/i)
                        .waitFor({ state: 'visible' })
                })
            },
        },
    ],
}

// Fill a Lexical contenteditable field by aria-label (mirrors the management-app
// fillLexicalField helper): click to focus, then type.
async function fillLexical(ctx: RunContext, ariaLabel: string, text: string): Promise<void> {
    const field = ctx.page.locator(`[aria-label="${ariaLabel}"]`)
    await field.click()
    await ctx.page.keyboard.type(text)
}
