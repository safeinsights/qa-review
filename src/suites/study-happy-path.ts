import { copyFile, mkdtemp, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { Page } from '@playwright/test'
import { expect } from '@playwright/test'
import { clickUntil } from '../engine/flows/interactions'
import {
    beginProposal,
    completeSetupAndCaptureId,
    fillProposal,
    fitStudyTitle,
    generateStudyContent,
    openProposalDashboard,
    type StudyContent,
    submitProposal,
} from '../engine/flows/study'
import { expectToastVisible } from '../engine/flows/toasts'
import { repoDir } from '../engine/paths'
import type { RunContext, Suite } from './types'

// Traces the FULL study lifecycle end-to-end in one continuous run, switching
// between the researcher and reviewer accounts (via ctx.loginAs) at each gate:
//
//   researcher: create study
//   reviewer:   approve proposal
//   researcher: route to /code, launch IDE, upload code, submit
//   reviewer:   request code changes (round 1)
//   researcher: resubmit code (round 2 == the re-run: a fresh job, and a
//               DIFFERENT script — the multi-query one, which uploads several
//               result files instead of round 1's single results.csv)
//   reviewer:   approve code (round 2)
//   (qa runs the job) -> poll until results appear
//   reviewer:   decrypt + approve results
//   researcher: decrypt the shared outputs with their OWN key and confirm they render
//   reviewer:   (end here so teardown cleanup has delete authority)
//
// Selectors mirror management-app/tests/study-flow.spec.ts. The suite logs in as
// researcher first (roles/--role), then switches accounts itself.
//
// The IDE launch opens an external Coder workspace in a new window and is REQUIRED:
// the button must appear, the popup must open, and it must load, or the step fails.
//
// Requires TWO results-decryption private keys, because the two roles decrypt
// different things: the Reviewer's opens the results the enclave returned, and the
// Researcher's opens the outputs the reviewer then SHARED back (OTTER-688 re-wraps
// those artifacts to the lab's keys). Set both "Results private key" fields for the
// target env (qa/staging) in the Settings panel. Each is per-account AND per-env;
// env.ts resolves the pair matching the running env (PR previews reuse qa), and
// ctx.resultsKey hands back whichever belongs to the currently signed-in role.

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
// The reviewer's decrypt field has carried two different wordings ("Enter your
// Results Key to access encrypted content." and, now, "Enter your security key"
// with aria-label "Security key"), so match on the part that survived rather
// than on a full literal — an exact-copy locator silently turned "results are
// ready" into "still running" and burned the whole results timeout.
//
// Restricted to the TEXTBOX role on purpose: the header profile menu holds a
// hidden menu item also named "Security key", so a plain getByLabel/text match
// resolves to that button in DOM order and then waits forever for a control
// that is never visible — the same failure with a new cause.
const RESULTS_KEY_COPY = /(results|security) key/i

// The entry point the enclave sources BY NAME, so it is load-bearing rather than
// cosmetic: it names the round-1 fixture, the name round 2's different script is
// staged under, the uploaded row asserted in the table, and both halves of the
// "elect a main file" accessible-name pair. Those last two only LOOK like
// interpolated strings, so a rename that missed them would fail as a selector
// timeout rather than a missing file.
const MAIN_FILE = 'main.r'

// The files the enclave returns, named exactly as the outputs table lists them.
// The round-2 script (multi-query-main.r) uploads five result files plus the
// archive; the security scan log is added by the enclave itself.
const SECURITY_LOG_FILE = 'security-scan-log.txt'
// The CSV whose preview is asserted as a grid, and the one `ensureOutputsDecrypted`
// uses as its "outputs are on screen" marker.
const RESULTS_FILE = 'tutor_results.csv'
// Every other file the round-2 script uploads. Presence in the outputs table is
// asserted; only RESULTS_FILE and the scan log get their previews opened, since
// the binary ones (plot.png, archive.zip) have no text/grid preview shape.
const ADDITIONAL_OUTPUT_FILES = [
    'exercises_results.csv',
    'tasks_over_time_agg.csv',
    'plot.png',
    'table.html',
    'archive.zip',
]

function resultsKeyBox(ctx: RunContext) {
    return ctx.page
        .getByRole('textbox', { name: RESULTS_KEY_COPY })
        .or(ctx.page.getByPlaceholder(RESULTS_KEY_COPY))
        .first()
}

// The results key, or a message naming the account whose key is actually missing.
// Built from ctx.role rather than hardcoded: the reviewer and the researcher decrypt
// with DIFFERENT keys (OTTER-688), so a fixed "Reviewer" would send whoever hits this
// as the researcher to the wrong Settings field — which is the misconfiguration this
// error exists to prevent them chasing.
function requireResultsKey(ctx: RunContext): string {
    const key = ctx.resultsKey
    if (!key) {
        const role = `${ctx.role[0].toUpperCase()}${ctx.role.slice(1)}`
        throw new Error(
            `Missing ${ctx.role} results key for this environment: set the ${role} ` +
                '"Results private key" for this env (qa/staging) in the Settings panel.'
        )
    }
    return key
}

// Short settle after isReactHydrated before clicking the "Proceed to step 3"
// next/link button: the App Router route entry for the /agreements segment wires
// up just after initial hydration, and a click in that gap no-ops silently.
const PROCEED_NAV_SETTLE_MS = 500

// Shared per-run state threaded between steps via ctx.state. `study` is the
// generated content; `studyId` is captured in Step 1 (the moment the study record
// is created) and reused by every later step. Helpers read them off ctx.state.
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
                await ctx.step(async () => {
                    await openProposalDashboard(ctx.page, ctx.baseURL)
                })
            },
        },
        {
            name: 'Start a new study proposal',
            run: ctx =>
                ctx.step(async () => {
                    await beginProposal(ctx.page)
                }),
        },
        {
            name: 'Step 1: name the study, choose org and language, then capture the study id',
            run: async ctx => {
                await ctx.step(async () => {
                    // OTTER-690 caps the title at 60 characters. generateStudyContent
                    // already fits it, but a RETRY of this step re-uses the title the
                    // first attempt put in ctx.state — so the clamp also has to live in
                    // the step that fills the field, and is written back so state
                    // matches the record that gets created.
                    const study = { ...content(ctx) }
                    study.title = fitStudyTitle(study.title)
                    ctx.state.study = study
                    // Proceeding to Step 2 creates the study record. Capture + track
                    // its id the instant it exists, so no created study is untracked.
                    const studyId = await completeSetupAndCaptureId(ctx.page, study.title)
                    ctx.state.studyId = studyId
                    ctx.trackStudy(studyId)
                })
            },
        },
        {
            name: 'Step 2: fill the proposal',
            run: ctx =>
                ctx.step(async () => {
                    await fillProposal(ctx.page, content(ctx))
                }),
        },
        {
            name: 'Submit the initial request',
            run: ctx =>
                ctx.step(async () => {
                    await submitProposal(ctx.page)
                    // Asserted AFTER submitProposal's own arrival wait, on purpose: the toast
                    // is raised before use-submit-proposal router.push()es, and the comment at
                    // that call site claims it survives the push because the Notifications
                    // provider lives in the persistent app shell. Checking it here is what
                    // verifies that claim rather than assuming it. This notice carries an
                    // EMPTY message, so the title is the whole assertion.
                    await expectToastVisible(ctx.page, { title: 'Proposal submitted' })
                }),
        },
        // ---- Reviewer: approve the proposal (gates the code-upload surface) ----
        {
            name: 'Switch to the reviewer account',
            run: ctx => ctx.step(() => ctx.loginAs('reviewer')),
        },
        {
            name: 'Reviewer approves the proposal',
            run: ctx =>
                ctx.step(async () => {
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
                }),
        },
        // ---- Researcher: route to code upload, launch IDE, upload + submit ----
        {
            name: 'Switch back to the researcher account',
            run: ctx => ctx.step(() => ctx.loginAs('researcher')),
        },
        {
            name: 'Route to the code upload page',
            run: ctx =>
                ctx.step(async () => {
                    await ctx.page.goto(
                        `${ctx.baseURL}/${RESEARCHER_ORG}/study/${id(ctx)}/submitted`,
                        {
                            waitUntil: 'domcontentloaded',
                        }
                    )
                    // Advance step-by-step, waiting for a distinctive element on each
                    // destination page: clicking "Proceed to step 3" lands on the agreements
                    // page, whose own "Proceed to Step 4" button is the arrival signal;
                    // clicking that lands on /code, signalled by "Upload your files".
                    //
                    // The "Proceed to step 3" anchor is server-rendered, so it is visible
                    // (and click-actionable) before the SPA finishes hydrating — a click that
                    // lands in that window is swallowed by the not-yet-mounted router and the
                    // page stays on /submitted. Wait for the app's hydration flag before the
                    // single click; a click on the hydrated page navigates reliably, so if it
                    // then fails to advance that is a real app bug this step should surface.
                    // Tight timeout on purpose: a healthy page hydrates in ~1s, so if the
                    // flag isn't set within a few seconds that is a real slow-hydration
                    // problem we want surfaced, not absorbed by the 30s default.
                    await ctx.page.waitForFunction(
                        () => (window as { isReactHydrated?: boolean }).isReactHydrated === true,
                        undefined,
                        { timeout: 5_000 }
                    )
                    // "Proceed to step 3" is a Mantine <Button component={next/link}>: its
                    // onClick preventDefaults the native anchor navigation and relies on the
                    // App Router's router.push. isReactHydrated flips true at initial
                    // hydration, but the client route entry for the /agreements segment wires
                    // up slightly later — a click in that gap is consumed while router.push
                    // no-ops, so the page silently stays on /submitted (no error). There's no
                    // exposed "route ready" signal to await, so settle briefly after
                    // hydration before the single click.
                    const proceedToStep3 = ctx.page.getByRole('link', {
                        name: /Proceed to step 3/i,
                    })
                    await proceedToStep3.waitFor({ state: 'visible' })
                    await ctx.page.waitForTimeout(PROCEED_NAV_SETTLE_MS)
                    await proceedToStep3.click()
                    // OTTER-727 (management-app #975, merged 2026-08-31) HID the
                    // agreements step this used to lead to: /submitted's Proceed button
                    // now computes the code step directly, and /agreements/researcher
                    // redirects rather than rendering. Waiting unconditionally for the
                    // gate's "Proceed to Step 4" therefore failed this step 30s AFTER it
                    // had already arrived at /code.
                    //
                    // The gate is kept in the codebase as intentionally unreachable, and
                    // that card notes restoring it is re-adding ONE rule entry — so this
                    // stays tolerant of both shapes rather than dropping the hop the way
                    // management-app's own navigateToCodeUpload helper did. Same approach
                    // openCodeReview() uses for the reviewer-side gate.
                    //
                    // Note the button still reads "Proceed to step 3" while landing on a
                    // page headed "STEP 4" — a known label/numbering gap deferred to
                    // OTTER-673, NOT a bug to re-report.
                    const proceedToStep4 = ctx.page.getByRole('button', {
                        name: /Proceed to Step 4/i,
                    })
                    const uploadFiles = ctx.page.getByText('Upload your files')
                    await Promise.race([
                        proceedToStep4.waitFor({ state: 'visible' }).catch(() => {}),
                        uploadFiles.waitFor({ state: 'visible' }).catch(() => {}),
                    ])
                    // Checked AFTER the race rather than instead of it: a gate that is on
                    // screen still has to be clicked, even when the race was won by the
                    // other locator.
                    if (await proceedToStep4.isVisible().catch(() => false)) {
                        await proceedToStep4.click()
                    }
                    await uploadFiles.waitFor({ state: 'visible' })
                }),
        },
        {
            name: 'Launch the IDE',
            // Click "Edit files in IDE" and require the external Coder IDE to open and
            // load the code-server workspace. The button is an anchor that normally
            // opens Coder in a NEW TAB (target=_blank). Under CDP-attached Chrome that
            // new tab does not reliably surface as a `page` event on ctx.page's context,
            // so waiting for one hangs. Instead we CTRL/CMD-CLICK (Shift here), which
            // suppresses target=_blank and forces the navigation to happen in the SAME
            // tab (ctx.page). The button must be present, the workspace must provision
            // and navigate here, its "Continue to launch IDE" OIDC re-auth + Clerk
            // sign-in must complete, and the code-server workbench must actually render.
            // Any of these failing FAILS the step — the IDE launch is part of the
            // researcher lifecycle we assert, not a best-effort nicety.
            run: ctx =>
                ctx.step(async () => {
                    const btn = ctx.page
                        .getByRole('button', { name: /Launch IDE|Edit files in IDE/i })
                        .first()
                    // A RETRY re-runs this step against the SAME live browser, parked
                    // wherever the failed attempt left it — for this step that is the
                    // Coder IDE tab, where this button does not exist. Without
                    // re-anchoring, every retry times out on a page that was never the
                    // subject, hiding the real cause (the IDE not loading). Gate the
                    // re-navigation on the BUTTON, not on a page-state marker: /code
                    // renders an "Upload your files" empty state before any file exists
                    // and a "Review files" table once the workspace has seeded them, so
                    // the button is the only signal stable across both. No-op on the
                    // normal path — the previous step already landed here.
                    if (!(await btn.isVisible().catch(() => false))) {
                        await ctx.page.goto(
                            `${ctx.baseURL}/${RESEARCHER_ORG}/study/${id(ctx)}/code`,
                            { waitUntil: 'domcontentloaded' }
                        )
                    }
                    await btn.waitFor({ state: 'visible' })
                    // On a cold workspace the app provisions the whole code-server
                    // environment FIRST ("Launching IDE" + a progress bar) and only then
                    // navigates. Ctrl/Cmd-click keeps that navigation in THIS tab. We
                    // don't wait on a Coder URL — the destination markers below (the
                    // "Continue to launch IDE" control or the workbench) are the real
                    // proof of arrival, and provisioning can take minutes.
                    await btn.click({ modifiers: ['Shift'] })
                    // Coder's OIDC uses prompt=login, so launching lands on Coder's
                    // "session expired / Continue to launch IDE" page — a LINK (not a
                    // button) to the OIDC callback — even though the app session is live.
                    // Follow it, which redirects through Clerk's hosted sign-in. On a warm
                    // session it may skip straight to the workbench, so only click Continue
                    // if it renders.
                    const continueControl = ctx.page
                        .getByRole('link', { name: /Continue to launch IDE/i })
                        .or(ctx.page.getByRole('button', { name: /Continue to launch IDE/i }))
                    const workbench = ctx.page.locator('.monaco-workbench')
                    // Cold-workspace provisioning can take minutes; this race (not a
                    // URL wait) is now the arrival gate, so give it the full budget.
                    const seen = await Promise.race([
                        continueControl
                            .first()
                            .waitFor({ state: 'visible', timeout: 300_000 })
                            .then(() => 'continue')
                            .catch(() => null),
                        workbench
                            .first()
                            .waitFor({ state: 'visible', timeout: 300_000 })
                            .then(() => 'workbench')
                            .catch(() => null),
                    ])
                    if (seen === 'continue') {
                        await continueControl.first().click()
                    }
                    // Complete Coder's Clerk-hosted OIDC sign-in as the current role (no-op
                    // if the workbench is already up), then require the code-server
                    // workbench to actually render — a Coder URL alone isn't proof the IDE
                    // loaded.
                    await signInToCoder(ctx, ctx.page)
                    await workbench.first().waitFor({ state: 'visible', timeout: 300_000 })
                    // The IDE is left OPEN on ctx.page; a later step navigates back to /code.
                }),
        },
        {
            name: 'Run main.r in the IDE',
            // Run main.R inside the open code-server IDE: open the file from the
            // Explorer, click the editor toolbar's "Run Source" action, then prove it
            // produced output by opening the generated results.csv and asserting it
            // contains a numeric value.
            //   - The Explorer shows the file as `main.R`; the toolbar action is an
            //     <a role=button> with aria-label "Run Source (⇧⌘S)".
            //   - Sourcing runs the file in an "R Interactive" terminal and writes
            //     results.csv to the workspace root (via write.csv). The Explorer doesn't
            //     auto-refresh for files the extension writes, so we click "Refresh
            //     Explorer" and poll until it appears.
            //   - Opening results.csv renders its rows as Monaco `.view-line`s; we require
            //     at least one line to contain a digit (the sample writes a header plus a
            //     count, e.g. 345).
            run: ctx =>
                ctx.step(async () => {
                    await ctx.page.getByRole('treeitem', { name: 'main.R' }).click()
                    await ctx.page
                        .getByRole('tab', { name: /main\.R/i })
                        .waitFor({ state: 'visible' })
                    await ctx.page.getByRole('button', { name: /Run Source/i }).click()
                    // Sourcing spins up (or reuses) the R Interactive terminal; require it.
                    await ctx.page.getByText('R Interactive').first().waitFor({ state: 'visible' })

                    const resultsFile = ctx.page.getByRole('treeitem', { name: 'results.csv' })
                    await expect(async () => {
                        await ctx.page.getByRole('button', { name: 'Refresh Explorer' }).click()
                        await expect(resultsFile).toBeVisible()
                    }).toPass()

                    await resultsFile.click()
                    await ctx.page
                        .getByRole('tab', { name: /results\.csv/i })
                        .waitFor({ state: 'visible' })
                    // Monaco renders each CSV row as a .view-line; require a numeric value.
                    const numericRow = ctx.page
                        .locator('.view-lines .view-line')
                        .filter({ hasText: /\d/ })
                    await expect(numericRow.first()).toBeVisible()
                }),
        },
        {
            name: 'Return to the code upload page',
            run: ctx =>
                ctx.step(async () => {
                    await ctx.page.goto(`${ctx.baseURL}/${RESEARCHER_ORG}/study/${id(ctx)}/code`, {
                        waitUntil: 'domcontentloaded',
                    })
                    // Files already exist (uploaded via the IDE run), so the page renders the
                    // "Review files" management view rather than the empty-state "Upload your
                    // files" prompt. The "Study code" heading anchors both states.
                    await ctx.page
                        .getByRole('heading', { name: 'Study code' })
                        .waitFor({ state: 'visible' })
                }),
        },
        {
            name: 'Upload the study code (round 1)',
            run: ctx =>
                ctx.step(async () => {
                    await ctx.page.locator('input[type="file"]').setInputFiles(fixtureFiles())
                    await ctx.page
                        .getByRole('cell', { name: MAIN_FILE, exact: true })
                        .waitFor({ state: 'visible' })
                    await ctx.page
                        .getByRole('cell', { name: 'code.r', exact: true })
                        .waitFor({ state: 'visible' })
                }),
        },
        {
            name: 'Submit the study code (round 1)',
            run: ctx =>
                ctx.step(async () => {
                    // Submitting requires an explicitly chosen main file. Every row's star
                    // starts aria-pressed="false" and "Submit code" stays disabled behind
                    // "Select a main file to submit" until one is pressed — uploading a file
                    // named main.r does NOT elect it.
                    //
                    // The star's accessible name FLIPS on selection — "Set main.r as main
                    // file" becomes "main.r is the main file" — so the two names are the
                    // control and the target. Targeting the Submit button instead would not
                    // work: it is always attached (merely rendered disabled), so clickUntil
                    // would count it as arrived and never press the star. Keying on the
                    // selected name also makes the retry idempotent, since a second press
                    // would toggle the selection back off.
                    await clickUntil(
                        ctx.page.getByRole('button', { name: `Set ${MAIN_FILE} as main file` }),
                        ctx.page.getByRole('button', { name: `${MAIN_FILE} is the main file` })
                    )
                    // The fixed AppShell footer intercepts pointer events on the button.
                    await ctx.page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
                    await ctx.page.getByRole('button', { name: /Submit code/i }).click()
                    await ctx.page.getByRole('button', { name: 'Yes, submit study code' }).click()
                    // Code submission redirects to CodePostSubmissionView; wait on its banner.
                    await ctx.page
                        .getByTestId('code-under-review-banner')
                        .waitFor({ state: 'visible' })
                    await expectToastVisible(ctx.page, {
                        title: 'Study Code Submitted',
                        message:
                            'Your code has been successfully submitted to the Data Partner. Check your dashboard for status updates.',
                    })
                }),
        },
        // ---- Reviewer: request code changes (round 1) ----
        {
            name: 'Switch to the reviewer account',
            run: ctx => ctx.step(() => ctx.loginAs('reviewer')),
        },
        {
            name: 'Reviewer requests code changes',
            run: ctx =>
                ctx.step(async () => {
                    await openCodeReview(ctx, id(ctx))
                    await setCodeCriteria(ctx, 'no')
                    await ctx.page.getByTestId('code-review-decision-needs-clarification').click()
                    await typeCodeFeedback(ctx, content(ctx).changeRequestFeedback)
                    await submitCodeReview(ctx, /Change requested on/)
                }),
        },
        // ---- Researcher: resubmit code (round 2 == the re-run) ----
        {
            name: 'Switch back to the researcher account',
            run: ctx => ctx.step(() => ctx.loginAs('researcher')),
        },
        {
            name: 'Resubmit the study code (round 2 / re-run)',
            run: ctx =>
                ctx.step(async () => {
                    await ctx.page.goto(
                        `${ctx.baseURL}/${RESEARCHER_ORG}/study/${id(ctx)}/resubmit`,
                        {
                            waitUntil: 'domcontentloaded',
                        }
                    )
                    await ctx.page
                        .getByRole('heading', { name: /Edit study code/i })
                        .waitFor({ state: 'visible' })
                    await ctx.page
                        .locator('input[type="file"]')
                        .setInputFiles(await resubmitFiles())
                    await ctx.page
                        .getByRole('cell', { name: MAIN_FILE, exact: true })
                        .waitFor({ state: 'visible' })
                    await ctx.page
                        .getByLabel(/Resubmission Note/i)
                        .fill(content(ctx).resubmissionNote)
                    // The fixed AppShell footer intercepts pointer events on the button.
                    await ctx.page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
                    await ctx.page.getByRole('button', { name: /^Resubmit study code$/i }).click()
                    await ctx.page
                        .getByRole('button', { name: /^Yes, resubmit study code$/i })
                        .click()
                    // Resubmit lands on the study view; the "Edit study code" heading
                    // is gone once submitted, so wait for that heading to detach as the
                    // signal the resubmit navigated away from the edit form.
                    await ctx.page
                        .getByRole('heading', { name: /Edit study code/i })
                        .waitFor({ state: 'hidden' })
                    await expectToastVisible(ctx.page, {
                        title: 'Study Code Resubmitted',
                        message: 'Your updated code has been submitted to the Data Partner.',
                    })
                }),
        },
        // ---- Reviewer: approve code (round 2) ----
        {
            name: 'Switch to the reviewer account',
            run: ctx => ctx.step(() => ctx.loginAs('reviewer')),
        },
        {
            name: 'Reviewer approves the code',
            run: ctx =>
                ctx.step(async () => {
                    await openCodeReview(ctx, id(ctx))
                    await setCodeCriteria(ctx, 'yes')
                    await ctx.page.getByTestId('code-review-decision-approve').click()
                    await typeCodeFeedback(ctx, content(ctx).codeApprovalFeedback)
                    await submitCodeReview(ctx, /Approved on/)
                }),
        },
        // ---- qa runs the job; wait for results, then decrypt + approve ----
        {
            name: 'Wait for the run to complete and produce results',
            run: ctx => ctx.step(() => waitForResults(ctx, id(ctx))),
        },
        {
            name: 'Reviewer decrypts and views the results',
            run: ctx =>
                ctx.step(async () => {
                    // Land on the review page ourselves rather than inheriting whatever
                    // state the previous step left behind, then decrypt.
                    await gotoReview(ctx, id(ctx))
                    await ensureOutputsDecrypted(ctx)
                    // The two previewable outputs must be viewable AND downloadable, so
                    // exercise each end-to-end. The security scan log is checked first
                    // because it is what a reviewer reads before trusting the results.
                    await viewOutputFile(ctx, SECURITY_LOG_FILE, 'text')
                    await downloadOutputFile(ctx, SECURITY_LOG_FILE)
                    await viewOutputFile(ctx, RESULTS_FILE, 'grid')
                    await downloadOutputFile(ctx, RESULTS_FILE)
                    // The multi-query script's remaining uploads: assert each is listed
                    // and downloadable. plot.png and archive.zip are binary, so they
                    // have no text/grid preview to open — downloading is what proves
                    // the decrypt produced real bytes for them.
                    for (const fileName of ADDITIONAL_OUTPUT_FILES) {
                        await downloadOutputFile(ctx, fileName)
                    }
                }),
        },
        {
            name: 'Reviewer approves the results',
            run: ctx =>
                ctx.step(async () => {
                    // A retry can start with the confirm dialog still open from the
                    // previous attempt, and it blocks every control behind it — so
                    // dismiss it before touching the form underneath.
                    const openConfirm = ctx.page
                        .getByRole('dialog')
                        .filter({ hasText: /submit your decision/i })
                    if (await openConfirm.isVisible().catch(() => false)) {
                        await openConfirm.getByRole('button', { name: /^cancel$/i }).click()
                        await openConfirm.waitFor({ state: 'hidden' })
                    }
                    // The decision controls only exist once the outputs are decrypted,
                    // and a reload drops that state — so re-establish it rather than
                    // assuming the previous step's page is still on screen.
                    await ensureOutputsDecrypted(ctx)
                    // The single "Approve" button is gone. The decision is now a radio
                    // pair ("Share outputs and feedback" = approve, "Share feedback only"
                    // = withhold the outputs), a required rich-text feedback box, and a
                    // "Submit decision" button.
                    await ctx.page
                        .getByRole('radio', { name: /share outputs and feedback/i })
                        .check()
                    const feedback = ctx.page.getByRole('textbox', { name: /decision feedback/i })
                    await feedback.click()
                    // ctx.state.study is generated ONCE, at the start of the run, and
                    // persists across step retries — so a run already in flight when a
                    // new content field is added carries the older object and yields
                    // undefined here. Fall back rather than fail a late step over text
                    // that only has to be non-empty.
                    const decisionFeedback =
                        content(ctx).resultsApprovalFeedback ??
                        `Outputs reviewed, no sensitive or restricted data found. (QA ${ctx.tag})`
                    // Clear before typing: on a replay the editor still holds the
                    // previous attempt's text, and keyboard.type APPENDS. (Typed rather
                    // than filled because this is a rich-text editor — fill() sets the
                    // DOM without the input events the editor tracks its model with.)
                    await ctx.page.keyboard.press('ControlOrMeta+A')
                    await ctx.page.keyboard.press('Backspace')
                    await ctx.page.keyboard.type(decisionFeedback)
                    // Opens a "Submit your decision?" confirm dialog, whose own
                    // "Submit decision" button is the one that commits. Both exist at
                    // that point, so the confirm click has to be scoped to the dialog —
                    // confirmDialog does that, and retries until the dialog closes.
                    await ctx.page.getByRole('button', { name: /submit decision/i }).click()
                    await confirmDialog(ctx, /^Submit decision$/i)
                    // Submitting stays on this Review outputs step and swaps the decision
                    // form for a confirmation alert — NOT the reviewer dashboard this
                    // used to wait for, which the app never navigates to here.
                    //
                    // The alert headline mirrors the decision that was made: approving
                    // with outputs reads "Outputs and feedback shared", while the
                    // "Share feedback only" radio yields a feedback-only variant. Asserting
                    // the outputs wording is therefore what distinguishes a real approval
                    // from a withhold, and it's the only approval signal on the page (the
                    // old "Approved on <date>" stamp is gone, so there's no date to
                    // freshness-check — the study is created fresh in step 3 of this run
                    // anyway, so a stale approval of the same id isn't reachable here).
                    await expect(ctx.page.getByText(/outputs and feedback shared/i)).toBeVisible()
                }),
        },
        // ---- Researcher: confirm the approved results are visible ----
        {
            name: 'Switch back to the researcher account',
            run: ctx => ctx.step(() => ctx.loginAs('researcher')),
        },
        {
            // OTTER-688 replaced this screen. It used to be a one-line status message
            // ("The results of your study have been approved by the Data Partner…") that the
            // researcher could read with no further action; the outputs are now GATED behind
            // the researcher's own security key, so the honest assertion is the whole
            // locked -> unlocked transition rather than a string.
            //
            // The researcher's key is not the reviewer's: 'share outputs' re-wraps the
            // artifacts to the LAB's public keys, so this decrypts with
            // RESEARCHER_RESULTS_PRIVATE_KEY_<ENV> while step 21 used the reviewer's. That is
            // why ctx.resultsKey now follows loginAs() instead of being pinned to the reviewer.
            name: 'Researcher decrypts and sees the shared outputs',
            run: ctx =>
                ctx.step(async () => {
                    await ctx.page.goto(`${ctx.baseURL}/${RESEARCHER_ORG}/study/${id(ctx)}/view`, {
                        waitUntil: 'domcontentloaded',
                    })
                    // Locked phase. Both halves are asserted: the banner is what tells the
                    // researcher WHY they are being asked for a key, and the form is the gate.
                    const keyForm = ctx.page.getByTestId('security-key-form')
                    await keyForm.waitFor({ state: 'visible' })
                    await expect(ctx.page.getByText(/Decrypt to view your outputs/i)).toBeVisible()
                    await resultsKeyBox(ctx).fill(requireResultsKey(ctx))
                    await ctx.page.getByRole('button', { name: /^view$/i }).click()
                    // Unlocked phase. The outputs table is the proof the key actually worked —
                    // the banner alone would flip on any state change.
                    await ctx.page
                        .getByRole('button', { name: RESULTS_FILE, exact: true })
                        .waitFor({ state: 'visible' })
                    await expect(
                        ctx.page.getByText(/Outputs and feedback available/i)
                    ).toBeVisible()
                    // The key form must LEAVE the DOM, not merely hide: the input, its error
                    // state and the decrypt handler all have to exit the tab order once the key
                    // has done its job, which the app commits to explicitly (OTTER-696 AC).
                    await expect(keyForm).toHaveCount(0)
                }),
        },
        {
            name: 'Switch to the admin account for cleanup authority',
            // End as admin so guaranteed teardown cleanup runs with delete
            // authority: the /api/qa DELETE endpoints require isSiAdmin, which the
            // researcher and reviewer accounts lack (a reviewer-session cleanup 401s).
            run: ctx => ctx.step(() => ctx.loginAs('admin')),
        },
        {
            name: 'Verify the study is deleted',
            // Delete the study via the QA cleanup API and ASSERT it succeeded, so a
            // cleanup failure fails the run loudly instead of being swallowed by the
            // engine's best-effort teardown (which folds a failed delete into a
            // non-fatal 'cleanup' category). The engine's later teardown delete of
            // the same id then harmlessly 404s.
            run: ctx =>
                ctx.step(async () => {
                    await deleteStudyAndVerify(ctx, id(ctx))
                }),
        },
    ],
}

// Delete a study through the QA cleanup API using the admin's Clerk session token
// (read from the page), assert a 2xx, then confirm a repeat delete reports it gone
// (404). Throws on anything else so cleanup problems surface as a failed step.
async function deleteStudyAndVerify(ctx: RunContext, studyId: string): Promise<void> {
    const token = await ctx.page.evaluate(async () => {
        const clerk = (
            window as unknown as {
                Clerk?: { session?: { getToken(): Promise<string | null> } }
            }
        ).Clerk
        return (await clerk?.session?.getToken()) ?? ''
    })
    if (!token) throw new Error('Could not read admin Clerk token to verify study cleanup')

    const del = () =>
        ctx.page.request.delete(`${ctx.baseURL}/api/qa/studies/${studyId}`, {
            headers: { Authorization: `Bearer ${token}` },
        })

    const res = await del()
    if (!res.ok()) {
        throw new Error(`QA cleanup DELETE study ${studyId} failed: HTTP ${res.status()}`)
    }
    // Confirm it's actually gone: a second delete finds nothing (404).
    const again = await del()
    if (again.status() !== 404) {
        throw new Error(
            `Study ${studyId} still present after delete (repeat DELETE returned ${again.status()}, expected 404)`
        )
    }
}

// --- helpers (mirror management-app/tests/study-flow.spec.ts) ---
// StudyContent, generateStudyContent, and fillLexical now live in
// ../engine/flows/study (shared with ad-hoc validation suites).

// The two code files the app accepts, resolved against the cloned repo (NOT the
// engine bundle location) via repoDir(), which honors QAR_REPO_DIR at runtime.
// (import.meta.url-relative paths would point at the bundle, not the clone.)
function fixtureDir(): string {
    return path.join(repoDir(), 'src', 'suites', 'fixtures', 'study-happy-path')
}

function fixtureFiles(): string[] {
    const dir = fixtureDir()
    return [path.join(dir, MAIN_FILE), path.join(dir, 'code.r')]
}

// The round-2 resubmission uploads a DIFFERENT script — the multi-query one, which
// runs several queries and uploads five result files plus an archive, so the re-run
// exercises a materially different job than round 1's single-query main.r.
//
// The enclave sources the entry point by name, so the uploaded file has to be
// `main.r`; the fixture is checked in under its own name to keep it distinct from
// round 1's. Copy it to a temp dir under the required name rather than renaming the
// fixture, so the two scripts can coexist in the repo.
async function resubmitFiles(): Promise<string[]> {
    const staged = path.join(await mkdtemp(path.join(tmpdir(), 'qar-resubmit-')), MAIN_FILE)
    await copyFile(path.join(fixtureDir(), 'multi-query-main.r'), staged)
    return [staged]
}

// Put the review page into the decrypted state, entering the reviewer's results
// key if it is being asked for. Decryption is client-side and does NOT survive a
// reload, so every step that needs the outputs has to be able to re-do this — a
// step that assumes the previous one left them on screen dies on any retry that
// follows a page load, with a locator timeout that names a control the app never
// had a chance to render.
async function ensureOutputsDecrypted(ctx: RunContext): Promise<void> {
    const keyBox = resultsKeyBox(ctx)
    const outputsReady = ctx.page.getByRole('button', { name: RESULTS_FILE, exact: true })
    // Whichever renders first tells us which of the two states the page is in.
    await Promise.race([
        keyBox.waitFor({ state: 'visible', timeout: 20_000 }).catch(() => {}),
        outputsReady.waitFor({ state: 'visible', timeout: 20_000 }).catch(() => {}),
    ])
    if (await outputsReady.isVisible().catch(() => false)) return
    const key = requireResultsKey(ctx)
    await keyBox.fill(key)
    // The submit control is a plain "View" (was "Decrypt Files"). Anchored, so it
    // can't drift onto the per-file buttons in the outputs table below, which don't
    // exist until this click succeeds.
    await ctx.page.getByRole('button', { name: /^view$/i }).click()
    await outputsReady.waitFor({ state: 'visible', timeout: 20_000 })
}

// Open one output file's preview, assert it actually rendered decrypted content,
// and close it again. The preview shape depends on the file: the CSV renders as a
// mantine-datatable grid built from its rows, the scan log as a <pre>. Asserting
// the WRONG shape is the trap here — a table-row assertion against the log waits
// out its timeout on a modal that is on screen and perfectly correct.
//
// Content is asserted as "non-empty", not as a fixed value, so the check survives
// run-to-run data changes while still failing a decrypt that yields empty/garbled
// output — the failure this step exists to catch.
async function viewOutputFile(
    ctx: RunContext,
    fileName: string,
    preview: 'grid' | 'text'
): Promise<void> {
    // exact:true keeps this off the row's "Download <fileName>" button, whose
    // accessible name CONTAINS the file name.
    const openButton = ctx.page.getByRole('button', { name: fileName, exact: true })
    await openButton.waitFor({ state: 'visible', timeout: 20_000 })
    await openButton.click()
    const dialog = ctx.page.getByRole('dialog')
    await dialog.waitFor({ state: 'visible', timeout: 20_000 })
    const body =
        preview === 'grid' ? dialog.locator('table tbody tr').first() : dialog.locator('pre')
    await body.waitFor({ state: 'visible', timeout: 15_000 })
    const text = (await body.innerText())?.trim() ?? ''
    if (!text) {
        const modalText = (await dialog.innerText())?.slice(0, 500) ?? ''
        throw new Error(`Preview of ${fileName} rendered empty. Modal text:\n${modalText}`)
    }
    // The Mantine modal's close control is an icon-only CloseButton with no
    // accessible name, so a name-based role locator can't find it — target the
    // stable Mantine class instead, and fall back to Escape.
    const closeButton = dialog.locator('.mantine-Modal-close')
    if (await closeButton.count()) {
        await closeButton.first().click()
    } else {
        await ctx.page.keyboard.press('Escape')
    }
    await dialog.waitFor({ state: 'hidden' })
}

// Download one output file from the table's Actions column and assert the browser
// actually received bytes. The app builds a blob URL and clicks a generated
// `<a download>`, so Playwright sees a real download event — asserting only that
// the button is clickable would pass even if the decrypt produced nothing.
async function downloadOutputFile(ctx: RunContext, fileName: string): Promise<void> {
    const downloadPromise = ctx.page.waitForEvent('download')
    await ctx.page.getByRole('button', { name: `Download ${fileName}`, exact: true }).click()
    const download = await downloadPromise
    expect(download.suggestedFilename()).toBe(fileName)
    const savedPath = await download.path()
    if (!savedPath) {
        throw new Error(`Download of ${fileName} produced no file: ${await download.failure()}`)
    }
    const { size } = await stat(savedPath)
    if (!size) throw new Error(`Downloaded ${fileName} is empty (0 bytes)`)
}

async function gotoReview(ctx: RunContext, studyId: string): Promise<void> {
    await ctx.page.goto(`${ctx.baseURL}/${REVIEWER_ORG}/study/${studyId}/review`, {
        waitUntil: 'domcontentloaded',
    })
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

// Complete Coder's Clerk-hosted OIDC sign-in as the current role, on the IDE popup
// page. Coder uses prompt=login, so launching the IDE always lands on Clerk's hosted
// sign-in (accounts.dev) — a DIFFERENT form from the app's embedded one (auth.ts):
// it's the staged flow email -> Continue -> password -> Continue -> SMS MFA code.
// Uses ctx.account (the currently signed-in role's creds), so the secret is typed by
// the engine, never surfaced. No-ops if the workbench is already up (warm session
// that skipped the login). A missing expected control FAILS the step.
async function signInToCoder(ctx: RunContext, ide: Page): Promise<void> {
    const workbench = ide.locator('.monaco-workbench')
    const emailField = ide.getByLabel(/Email address/i)
    // Either the IDE is already loaded (no login needed) or the Clerk email step is
    // up. Wait for whichever appears before deciding.
    await Promise.race([
        workbench
            .first()
            .waitFor({ state: 'visible', timeout: 60_000 })
            .catch(() => {}),
        emailField
            .first()
            .waitFor({ state: 'visible', timeout: 60_000 })
            .catch(() => {}),
    ])
    if (
        await workbench
            .first()
            .isVisible()
            .catch(() => false)
    )
        return
    if (
        !(await emailField
            .first()
            .isVisible()
            .catch(() => false))
    ) {
        throw new Error(
            `IDE did not open: expected the Coder/Clerk sign-in or the code-server ` +
                `workbench, but neither rendered. URL: ${ide.url()}`
        )
    }
    // Email -> Continue.
    await emailField.first().fill(ctx.account.email)
    await ide.getByRole('button', { name: /^Continue$/i }).click()
    // Password -> Continue. Clerk labels the field "Password"; the primary button is
    // "Continue" on the hosted flow.
    const passwordField = ide.getByLabel(/^Password$/i)
    await passwordField.waitFor({ state: 'visible', timeout: 60_000 })
    await passwordField.fill(ctx.account.password)
    await ide.getByRole('button', { name: /^Continue$/i }).click()
    // SMS MFA: the same fixed second-factor code the app login uses. Clerk renders a
    // one-time-code input (a row of single-char boxes or one combined field); fill it
    // and, if a submit button is shown rather than auto-advancing, click it.
    await fillCoderMfa(ide, ctx.account.mfaCode)
    // The verified login redirects back to Coder; the workbench assertion in the
    // caller confirms code-server actually rendered.
}

// Enter the SMS MFA code on Clerk's hosted verification step, on the IDE popup page.
// The code input is a segmented OTP field: try the per-digit inputs first, else a
// single combined field.
async function fillCoderMfa(ide: Page, code: string): Promise<void> {
    const otpInputs = ide.locator('input[inputmode="numeric"], input[autocomplete="one-time-code"]')
    await otpInputs.first().waitFor({ state: 'visible', timeout: 60_000 })
    const count = await otpInputs.count()
    if (count > 1) {
        const digits = code.split('')
        for (let i = 0; i < digits.length && i < count; i++) {
            await otpInputs.nth(i).fill(digits[i])
        }
    } else {
        await otpInputs.first().fill(code)
    }
    // Some Clerk configs auto-submit on the last digit; others need a click.
    const submit = ide.getByRole('button', { name: /^(Continue|Verify)/i })
    if (
        await submit
            .first()
            .isVisible()
            .catch(() => false)
    ) {
        await submit
            .first()
            .click()
            .catch(() => {})
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
    const keyBox = () => resultsKeyBox(ctx)
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
