import path from 'node:path'
import { faker } from '@faker-js/faker'
import type { Locator } from '@playwright/test'
import { repoDir } from '@/engine/paths'
import type { RunContext, Suite } from '@/suites/types'

// Traces the FULL study lifecycle end-to-end in one continuous run, switching
// between the researcher and reviewer accounts (via ctx.loginAs) at each gate:
//
//   researcher: create study
//   reviewer:   approve proposal
//   researcher: route to /code, launch IDE (best-effort), upload code, submit
//   reviewer:   request code changes (round 1)
//   researcher: resubmit code (round 2 == the re-run: a fresh job)
//   reviewer:   approve code (round 2)
//   (qa runs the job) -> poll until results appear
//   reviewer:   decrypt + approve results
//   researcher: confirm results approved
//   reviewer:   (end here so teardown cleanup has delete authority)
//
// Selectors mirror management-app/tests/study-flow.spec.ts. The suite logs in as
// researcher first (roles/--role), then switches accounts itself.
//
// The IDE launch opens an external Coder workspace in a new window and is treated
// as NON-FATAL — a Coder hiccup must never sink the lifecycle trace.
//
// Requires the reviewer's results-decryption private key to approve results:
// set the Reviewer "Results private key" for the target env (qa/staging) in the
// Settings panel. The key is per-account AND per-env; env.ts resolves the one
// matching the running env (PR previews reuse qa) into ctx.resultsKey.

const RESEARCHER_DASH = '/openstax-lab/dashboard'
const RESEARCHER_ORG = 'openstax-lab'
const REVIEWER_ORG = 'openstax'
const CODE_CRITERIA_KEYS = [
    'proposalAlignment',
    'agreementCompliance',
    'securityChecks',
    'privacyProtection',
]

// How long to wait for the external enclave runner to produce results before
// giving up. The run happens outside the app (an editor service polls for
// approved jobs and POSTs encrypted results back), so this can take minutes.
const RESULTS_TIMEOUT_MS = 15 * 60_000
const RESULTS_POLL_INTERVAL_MS = 15_000
// Per-poll active-wait window: after each reload, wait this long for the results
// key box (or error) to actually render before deciding the results aren't ready
// yet. Covers the reload + SPA hydration so a not-yet-rendered box isn't missed.
const RESULTS_RENDER_WAIT_MS = 8_000

// Shared per-run state threaded between steps via ctx.state. `study` is the
// generated content; `studyId` is captured at Step 2 and reused by every later
// step. Helpers read them off ctx.state (cast at the use site).
function content(ctx: RunContext): StudyContent {
    return ctx.state.study as StudyContent
}
function id(ctx: RunContext): string {
    return ctx.state.studyId as string
}

export const studyHappyPathSuite: Suite = {
    name: 'study-happy-path',
    description:
        'Full study lifecycle: create, upload, IDE, submit, review, resubmit, re-run, approve results',
    roles: ['researcher'],
    steps: [
        // ---- Researcher: create + submit the proposal (mirrors create-study) ----
        {
            name: 'Open the researcher org dashboard',
            run: async ctx => {
                // Realistic-but-clearly-synthetic study + review content (faker).
                // ctx.tag stays in the title so the row is findable and traceable.
                ctx.state.study = generateStudyContent(ctx.tag)
                await ctx.step('Open the researcher org dashboard', async () => {
                    await ctx.page.goto(`${ctx.baseURL}${RESEARCHER_DASH}`, {
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
                // Track for cleanup BEFORE anything else can fail — the study exists now.
                ctx.state.studyId = studyId
                ctx.trackStudy(studyId)
            },
        },
        {
            name: 'Step 2: fill the proposal',
            run: async ctx => {
                await ctx.step('Step 2: fill the proposal', async () => {
                    const study = content(ctx)
                    await ctx.page.getByLabel('Study Title').fill(study.title)
                    await ctx.page.getByPlaceholder('Select dataset(s) of interest').click()
                    await ctx.page.getByRole('option').first().click()
                    await fillLexical(ctx, 'Research question(s)', study.researchQuestion)
                    await fillLexical(ctx, 'Project summary', study.summary)
                    await fillLexical(ctx, 'Impact', study.impact)
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
        // ---- Reviewer: approve the proposal (gates the code-upload surface) ----
        {
            name: 'Switch to the reviewer account',
            run: async ctx => {
                await ctx.step('Switch to the reviewer account', async () => {
                    await ctx.loginAs('reviewer')
                })
            },
        },
        {
            name: 'Reviewer approves the proposal',
            run: async ctx => {
                await ctx.step('Reviewer approves the proposal', async () => {
                    await gotoReview(ctx, id(ctx))
                    const feedback = ctx.page
                        .getByTestId('review-feedback-section')
                        .locator('[contenteditable="true"]')
                    await feedback.click()
                    await ctx.page.keyboard.type(content(ctx).proposalFeedback)
                    await ctx.page
                        .getByTestId('review-decision-section')
                        .getByRole('radio', { name: /^Approve$/i })
                        .check()
                    await ctx.page.getByRole('button', { name: /^Submit review$/i }).click()
                    await confirmDialog(ctx, /^Yes, submit review$/i)
                    await ctx.page.getByText(/Approved on/).waitFor({ state: 'visible' })
                })
            },
        },
        // ---- Researcher: route to code upload, launch IDE, upload + submit ----
        {
            name: 'Switch back to the researcher account',
            run: async ctx => {
                await ctx.step('Switch back to the researcher account', async () => {
                    await ctx.loginAs('researcher')
                })
            },
        },
        {
            name: 'Route to the code upload page',
            run: async ctx => {
                await ctx.step('Route to the code upload page', async () => {
                    await ctx.page.goto(
                        `${ctx.baseURL}/${RESEARCHER_ORG}/study/${id(ctx)}/submitted`,
                        {
                            waitUntil: 'domcontentloaded',
                        }
                    )
                    await clickAndWaitForURL(
                        ctx,
                        ctx.page.getByRole('link', { name: /Proceed to step 3/i }),
                        /\/agreements\/researcher(\?.*)?$/
                    )
                    await clickAndWaitForURL(
                        ctx,
                        ctx.page.getByRole('button', { name: /Proceed to Step 4/i }),
                        /\/code$/
                    )
                    await ctx.page.getByText('Upload your files').waitFor({ state: 'visible' })
                })
            },
        },
        {
            name: 'Launch the IDE (best-effort)',
            run: async ctx => {
                await ctx.step('Launch the IDE (best-effort)', async () => {
                    await launchIdeBestEffort(ctx)
                })
            },
        },
        {
            name: 'Upload the study code (round 1)',
            run: async ctx => {
                await ctx.step('Upload the study code (round 1)', async () => {
                    await uploadCode(ctx)
                })
            },
        },
        {
            name: 'Submit the study code (round 1)',
            run: async ctx => {
                await ctx.step('Submit the study code (round 1)', async () => {
                    await submitCode(ctx)
                })
            },
        },
        // ---- Reviewer: request code changes (round 1) ----
        {
            name: 'Switch to the reviewer account',
            run: async ctx => {
                await ctx.step('Switch to the reviewer account', async () => {
                    await ctx.loginAs('reviewer')
                })
            },
        },
        {
            name: 'Reviewer requests code changes',
            run: async ctx => {
                await ctx.step('Reviewer requests code changes', async () => {
                    await openCodeReview(ctx, id(ctx))
                    await setCodeCriteria(ctx, 'no')
                    await ctx.page.getByTestId('code-review-decision-needs-clarification').click()
                    await typeCodeFeedback(ctx, content(ctx).changeRequestFeedback)
                    await submitCodeReview(ctx, /Change requested on/)
                })
            },
        },
        // ---- Researcher: resubmit code (round 2 == the re-run) ----
        {
            name: 'Switch back to the researcher account',
            run: async ctx => {
                await ctx.step('Switch back to the researcher account', async () => {
                    await ctx.loginAs('researcher')
                })
            },
        },
        {
            name: 'Resubmit the study code (round 2 / re-run)',
            run: async ctx => {
                await ctx.step('Resubmit the study code (round 2 / re-run)', async () => {
                    await ctx.page.goto(
                        `${ctx.baseURL}/${RESEARCHER_ORG}/study/${id(ctx)}/resubmit`,
                        {
                            waitUntil: 'domcontentloaded',
                        }
                    )
                    await ctx.page
                        .getByRole('heading', { name: /Edit study code/i })
                        .waitFor({ state: 'visible' })
                    await ctx.page.locator('input[type="file"]').setInputFiles(fixtureFiles())
                    await ctx.page
                        .getByLabel(/Resubmission Note/i)
                        .fill(content(ctx).resubmissionNote)
                    // The fixed AppShell footer intercepts pointer events on the submit button.
                    await ctx.page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
                    await ctx.page.getByRole('button', { name: /^Resubmit study code$/i }).click()
                    await ctx.page
                        .getByRole('button', { name: /^Yes, resubmit study code$/i })
                        .click()
                    await ctx.page.waitForURL('**/view')
                })
            },
        },
        // ---- Reviewer: approve code (round 2) ----
        {
            name: 'Switch to the reviewer account',
            run: async ctx => {
                await ctx.step('Switch to the reviewer account', async () => {
                    await ctx.loginAs('reviewer')
                })
            },
        },
        {
            name: 'Reviewer approves the code',
            run: async ctx => {
                await ctx.step('Reviewer approves the code', async () => {
                    await openCodeReview(ctx, id(ctx))
                    await setCodeCriteria(ctx, 'yes')
                    await ctx.page.getByTestId('code-review-decision-approve').click()
                    await typeCodeFeedback(ctx, content(ctx).codeApprovalFeedback)
                    await submitCodeReview(ctx, /Approved on/)
                })
            },
        },
        // ---- qa runs the job; wait for results, then decrypt + approve ----
        {
            name: 'Wait for the run to complete and produce results',
            run: async ctx => {
                await ctx.step('Wait for the run to complete and produce results', async () => {
                    await waitForResults(ctx, id(ctx))
                })
            },
        },
        {
            name: 'Reviewer decrypts and views the results',
            run: async ctx => {
                await ctx.step('Reviewer decrypts and views the results', async () => {
                    const key = ctx.resultsKey
                    if (!key) {
                        throw new Error(
                            'Missing reviewer results key for this environment: set the Reviewer "Results private key" ' +
                                'for this env (qa/staging) in the Settings panel.'
                        )
                    }
                    await ctx.page
                        .getByPlaceholder('Enter your Results Key to access encrypted content.')
                        .fill(key)
                    await ctx.page.getByRole('button', { name: /Decrypt Files/i }).click()
                    // Open the RESULTS file's preview — NOT a run log — and confirm it
                    // actually rendered the decrypted output, not just that a View
                    // button exists. The decrypted-file table lists several rows
                    // (the results output plus code-run / security / packaging logs);
                    // each has its own "View" button, so we must open the one on the
                    // results row rather than blindly taking the first View button.
                    await openResultsPreview(ctx)
                    await verifyResultsModalHasContent(ctx)
                    // Close the preview so it doesn't overlay the Approve button.
                    await ctx.page
                        .getByRole('dialog')
                        .getByRole('button', { name: /close/i })
                        .first()
                        .click()
                    await ctx.page
                        .getByRole('dialog')
                        .waitFor({ state: 'hidden' })
                        .catch(() => {})
                })
            },
        },
        {
            name: 'Reviewer approves the results',
            run: async ctx => {
                await ctx.step('Reviewer approves the results', async () => {
                    await ctx.page
                        .getByRole('button', { name: /^Approve$/i })
                        .last()
                        .click()
                    await ctx.page.waitForURL('**/dashboard')
                })
            },
        },
        // ---- Researcher: confirm the approved results are visible ----
        {
            name: 'Switch back to the researcher account',
            run: async ctx => {
                await ctx.step('Switch back to the researcher account', async () => {
                    await ctx.loginAs('researcher')
                })
            },
        },
        {
            name: 'Researcher sees the approved results',
            run: async ctx => {
                await ctx.step('Researcher sees the approved results', async () => {
                    await ctx.page.goto(`${ctx.baseURL}/${RESEARCHER_ORG}/study/${id(ctx)}/view`, {
                        waitUntil: 'domcontentloaded',
                    })
                    await ctx.page
                        .getByText(/results of your study have been approved/i)
                        .waitFor({ state: 'visible' })
                })
            },
        },
        {
            name: 'Switch to the admin account for cleanup authority',
            // End as admin so guaranteed teardown cleanup runs with delete
            // authority: the /api/qa DELETE endpoints require isSiAdmin, which the
            // researcher and reviewer accounts lack (a reviewer-session cleanup 401s).
            run: async ctx => {
                await ctx.step('Switch to the admin account for cleanup authority', async () => {
                    await ctx.loginAs('admin')
                })
            },
        },
    ],
}

// --- helpers (mirror management-app/tests/study-flow.spec.ts) ---

interface StudyContent {
    title: string
    researchQuestion: string
    summary: string
    impact: string
    proposalFeedback: string
    changeRequestFeedback: string
    resubmissionNote: string
    codeApprovalFeedback: string
}

// Realistic-but-synthetic study + review text via faker, using English-word
// generators (not the Latin faker.lorem). The title keeps `tag` (the
// unique-per-run suffix) so the study row stays findable and traceable.
function generateStudyContent(tag: string): StudyContent {
    const topic = faker.commerce.productName().toLowerCase()
    const cohort = faker.helpers.arrayElement([
        'first-year',
        'transfer',
        'STEM',
        'part-time',
        'online',
    ])
    const outcome = faker.helpers.arrayElement([
        'course completion',
        'assessment scores',
        'time-on-task',
        'retention',
        'engagement',
    ])
    // Join 2–3 English-ish sentences into one paragraph; up to `paras` paragraphs.
    const para = () =>
        faker.helpers.multiple(() => faker.hacker.phrase(), { count: { min: 2, max: 3 } }).join(' ')
    const body = (paras: number) =>
        faker.helpers.multiple(para, { count: { min: 1, max: paras } }).join('\n\n')
    return {
        title: `${faker.company.catchPhraseNoun()} and ${outcome} (QA ${tag})`,
        researchQuestion: `How does ${topic} relate to ${outcome} among ${cohort} students? ${faker.hacker.phrase()}`,
        summary: body(2),
        impact: `This work informs ${faker.company.buzzPhrase()}. ${faker.hacker.phrase()}`,
        proposalFeedback: `Approving this initial request. ${body(1)}`,
        changeRequestFeedback: `Requesting revisions before approval. ${body(1)}`,
        resubmissionNote: `Addressed reviewer feedback. ${body(1)}`,
        codeApprovalFeedback: `Code approved and ready to run. ${body(1)}`,
    }
}

// The two code files the app accepts, resolved against the cloned repo (NOT the
// bundle) — build-suites bundles this suite into suites-compiled/, so module-
// relative paths would break; repoDir() honors QAR_REPO_DIR at runtime.
function fixtureFiles(): string[] {
    const dir = path.join(repoDir(), 'src', 'suites', 'fixtures', 'study-happy-path')
    return [path.join(dir, 'main.r'), path.join(dir, 'code.r')]
}

// Fill a Lexical contenteditable field by aria-label: click to focus, then type.
async function fillLexical(ctx: RunContext, ariaLabel: string, text: string): Promise<void> {
    const field = ctx.page.locator(`[aria-label="${ariaLabel}"]`)
    await field.click()
    await ctx.page.keyboard.type(text)
}

async function gotoReview(ctx: RunContext, studyId: string): Promise<void> {
    await ctx.page.goto(`${ctx.baseURL}/${REVIEWER_ORG}/study/${studyId}/review`, {
        waitUntil: 'domcontentloaded',
    })
}

// Click a nav control and wait for the URL to match. On the PR preview the app is
// client-rendered and a click can land before the SPA router is ready (so the
// navigation never fires); retry the click once with a generous per-attempt
// budget before giving up.
async function clickAndWaitForURL(ctx: RunContext, target: Locator, urlRe: RegExp): Promise<void> {
    for (let attempt = 0; attempt < 2; attempt++) {
        await target.click()
        const navigated = await ctx.page
            .waitForURL(urlRe, { timeout: 45_000 })
            .then(() => true)
            .catch(() => false)
        if (navigated) return
    }
    // One last wait so the caller gets the real timeout error if it truly never navigated.
    await ctx.page.waitForURL(urlRe, { timeout: 15_000 })
}

// Confirm in the modal and wait for it to close. On the live preview the confirm
// click can land before the dialog's handler is wired, leaving it open — retry
// the click until the dialog hides.
async function confirmDialog(ctx: RunContext, confirmName: RegExp): Promise<void> {
    const dialog = ctx.page.getByRole('dialog')
    await dialog.waitFor({ state: 'visible' })
    for (let attempt = 0; attempt < 3; attempt++) {
        await dialog
            .getByRole('button', { name: confirmName })
            .click()
            .catch(() => {})
        const hidden = await dialog
            .waitFor({ state: 'hidden', timeout: 20_000 })
            .then(() => true)
            .catch(() => false)
        if (hidden) return
    }
    // Surface the real error if it genuinely never closed.
    await dialog.waitFor({ state: 'hidden', timeout: 10_000 })
}

// Reach the code-review editor. When the reviewer hasn't acked the agreements, an
// agreements gate (STEP 2A/2B/2C) renders first and its "Proceed to Step 3" button
// advances to the code-review editor. On the live preview that gate can take a
// moment to hydrate, so poll: each round, if the code-review section is up we're
// done; else click "Proceed to Step 3" if present and wait.
async function openCodeReview(ctx: RunContext, studyId: string): Promise<void> {
    const section = ctx.page.getByTestId('code-review-section')
    const proceed = ctx.page.getByRole('button', { name: /Proceed to Step 3/i })
    for (let attempt = 0; attempt < 4; attempt++) {
        await gotoReview(ctx, studyId)
        // Either the editor renders directly, or the agreements gate does — wait
        // for whichever appears first before deciding.
        await Promise.race([
            section.waitFor({ state: 'visible', timeout: 20_000 }).catch(() => {}),
            proceed.waitFor({ state: 'visible', timeout: 20_000 }).catch(() => {}),
        ])
        if (await section.isVisible().catch(() => false)) return
        if (await proceed.isVisible().catch(() => false)) {
            await proceed.click().catch(() => {})
            if (
                await section
                    .waitFor({ state: 'visible', timeout: 20_000 })
                    .then(() => true)
                    .catch(() => false)
            ) {
                return
            }
        }
    }
    // Final wait so a genuine failure surfaces the real timeout error.
    await section.waitFor({ state: 'visible', timeout: 15_000 })
}

async function setCodeCriteria(ctx: RunContext, value: 'yes' | 'no'): Promise<void> {
    for (const key of CODE_CRITERIA_KEYS) {
        await ctx.page.locator(`input[name="criteria-${key}"][value="${value}"]`).check()
    }
}

async function typeCodeFeedback(ctx: RunContext, text: string): Promise<void> {
    const feedback = ctx.page
        .getByTestId('code-review-section')
        .locator('[contenteditable="true"]')
        .first()
    await feedback.click()
    await ctx.page.keyboard.type(text)
}

async function submitCodeReview(ctx: RunContext, doneRegex: RegExp): Promise<void> {
    await ctx.page.getByTestId('code-review-submit').click()
    await confirmDialog(ctx, /^Yes, submit review$/i)
    await ctx.page.getByText(doneRegex).waitFor({ state: 'visible' })
}

async function uploadCode(ctx: RunContext): Promise<void> {
    await ctx.page.locator('input[type="file"]').setInputFiles(fixtureFiles())
    await ctx.page.getByRole('cell', { name: 'main.r', exact: true }).waitFor({ state: 'visible' })
    await ctx.page.getByRole('cell', { name: 'code.r', exact: true }).waitFor({ state: 'visible' })
}

async function submitCode(ctx: RunContext): Promise<void> {
    // The fixed AppShell footer intercepts pointer events on the submit button.
    await ctx.page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
    await ctx.page.getByRole('button', { name: /Submit code/i }).click()
    await ctx.page.getByRole('button', { name: 'Yes, submit study code' }).click()
    // Code submission redirects to CodePostSubmissionView; wait on its banner.
    await ctx.page.getByTestId('code-under-review-banner').waitFor({ state: 'visible' })
}

// Click "Launch IDE" and, if it opens a new window, screenshot then close it.
// NON-FATAL: a popup block, a Coder stub, or a same-window branch on qa must never
// fail the lifecycle trace — the IDE provisions an external service we don't own.
async function launchIdeBestEffort(ctx: RunContext): Promise<void> {
    try {
        const btn = ctx.page.getByRole('button', { name: /Launch IDE|Edit files in IDE/i }).first()
        if (!(await btn.isVisible().catch(() => false))) return
        const [popup] = await Promise.all([
            ctx.page
                .context()
                .waitForEvent('page', { timeout: 60_000 })
                .catch(() => null),
            btn.click(),
        ])
        if (popup) {
            await popup.waitForLoadState('domcontentloaded').catch(() => {})
            await popup.close().catch(() => {})
        }
    } catch {
        // Swallow — the IDE is an external service and must not fail the run.
    }
}

// Poll the reviewer review page until the run produces decryptable results (the
// results-key box appears) or the job errors / we time out. Re-navigates each
// poll because the review page caches its server data.
//
// Each poll ACTIVELY WAITS through the reload's render window rather than taking
// one instant isVisible() snapshot: a bare snapshot right after domcontentloaded
// routinely misses the SPA render (the box is there a moment later), so the loop
// would sleep a full interval and the results screen sits unnoticed for many
// seconds. We race the key box vs. the error text with a bounded waitFor so we
// react the instant either renders; a short sleep only spaces genuine retries.
async function waitForResults(ctx: RunContext, studyId: string): Promise<void> {
    const deadline = Date.now() + RESULTS_TIMEOUT_MS
    const keyBox = () =>
        ctx.page.getByPlaceholder('Enter your Results Key to access encrypted content.')
    const errored = () => ctx.page.getByText(/The code errored/i)
    while (Date.now() < deadline) {
        await gotoReview(ctx, studyId)
        // Wait out the render window (reload + SPA hydration + a margin) for
        // whichever terminal state appears first, instead of a single snapshot.
        await Promise.race([
            keyBox()
                .waitFor({ state: 'visible', timeout: RESULTS_RENDER_WAIT_MS })
                .catch(() => {}),
            errored()
                .waitFor({ state: 'visible', timeout: RESULTS_RENDER_WAIT_MS })
                .catch(() => {}),
        ])
        if (
            await keyBox()
                .isVisible()
                .catch(() => false)
        )
            return
        if (
            await errored()
                .isVisible()
                .catch(() => false)
        ) {
            throw new Error(`Study ${studyId} run ERRORED before producing results`)
        }
        await ctx.page.waitForTimeout(RESULTS_POLL_INTERVAL_MS)
    }
    throw new Error(
        `Timed out after ${RESULTS_TIMEOUT_MS / 60_000}min waiting for run results on study ${studyId}. ` +
            `The qa enclave runner may be slow or down — check ${ctx.baseURL}/${REVIEWER_ORG}/study/${studyId}/review`
    )
}

// Open the preview modal for the RESULTS file specifically. The decrypted-file
// table (a plain <table>) lists the results output alongside run logs (Code Run
// Log, Security Scan Log, Packaging Error Log); every row has its own "View"
// button. The results row is the one whose "File Type" cell reads "Results"
// (see management-app logLabel()) — the log rows carry a "… Log" label instead.
// We scope the View click to that row so we preview the actual output, not a log.
async function openResultsPreview(ctx: RunContext): Promise<void> {
    const resultsRow = ctx.page
        .getByRole('row')
        .filter({ has: ctx.page.getByRole('cell', { name: 'results' }) })
        .first()
    const viewButton = resultsRow.getByRole('button', { name: 'View' })
    await viewButton.waitFor({ state: 'visible', timeout: 20_000 })
    await viewButton.click()
}

// Assert the open results-preview modal actually rendered the decrypted output.
// The results file is a CSV, previewed as a mantine-datatable grid whose rows the
// app builds from the CSV — so a successful decrypt shows data rows, while a
// decrypt-but-empty/garbled result would show a header-only (or empty) grid. We
// wait for at least one populated data row and confirm it carries some content,
// rather than asserting a specific value so it survives run-to-run data changes.
async function verifyResultsModalHasContent(ctx: RunContext): Promise<void> {
    const dialog = ctx.page.getByRole('dialog')
    await dialog.waitFor({ state: 'visible', timeout: 20_000 })
    // The CSV parses + DataTable hydrates a moment after the modal opens; wait for
    // a body row to render, then confirm the grid holds non-empty cell text.
    const firstRow = dialog.locator('table tbody tr').first()
    await firstRow.waitFor({ state: 'visible', timeout: 15_000 })
    const text = (await firstRow.innerText())?.trim() ?? ''
    if (!text) {
        const modalText = (await dialog.innerText())?.slice(0, 500) ?? ''
        throw new Error(
            `Results preview modal rendered an empty grid row. Modal text:\n${modalText}`
        )
    }
}
