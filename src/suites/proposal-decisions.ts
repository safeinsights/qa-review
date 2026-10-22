import { expect } from '@playwright/test'
import { clickUntil } from '../engine/flows/interactions'
import type { StudyContent } from '../engine/flows/study'
import { DEFAULT_RESEARCHER_ORG, fillLexical } from '../engine/flows/study'
import {
    confirmDialog,
    gotoReview,
    proposalSubmissionSteps,
    submitProposalDecision,
} from './study-happy-path'
import type { RunContext, Suite } from './types'

// The two proposal decisions study-happy-path never takes. It always approves, so the
// reviewer's "Request revision" and "Decline and end study", and the researcher's whole
// Edit proposal page in between, ran nowhere outside management-app's seeded e2e:
//
//   researcher: submit a proposal
//   reviewer:   request a revision
//   researcher: read the feedback, revise a field, resubmit with a note (v2.0)
//   reviewer:   sees the revision and the note, declines
//   researcher: sees the decline, and can no longer edit
//
// The revised field and the note are both asserted on the REVIEWER's side, which is what
// proves the edit round-tripped rather than just that the page accepted it.

const RESEARCHER_ORG = DEFAULT_RESEARCHER_ORG

const NOTE_REQUIRED = 'Enter your resubmission note before continuing.'

function content(ctx: RunContext): StudyContent {
    return ctx.state.study as StudyContent
}
function id(ctx: RunContext): string {
    return ctx.state.studyId as string
}
// Derived from the run tag so a retried step re-types the same text.
function revisedQuestion(ctx: RunContext): string {
    return `Revised research question for ${ctx.tag}`
}
function declineFeedback(ctx: RunContext): string {
    return `Declining after revision for ${ctx.tag}`
}

function statusAlert(ctx: RunContext, title: RegExp) {
    return ctx.page.getByTestId('status-alert').filter({ hasText: title })
}

async function gotoSubmitted(ctx: RunContext): Promise<void> {
    await ctx.page.goto(`${ctx.baseURL}/${RESEARCHER_ORG}/study/${id(ctx)}/submitted`, {
        waitUntil: 'domcontentloaded',
    })
}

export const proposalDecisionsSuite: Suite = {
    name: 'proposal-decisions',
    description:
        'Proposal review decisions: request a revision, edit and resubmit with a note, then decline',
    roles: ['researcher'],
    steps: [
        ...proposalSubmissionSteps(RESEARCHER_ORG),
        {
            name: 'Switch to the reviewer account',
            run: ctx => ctx.step(() => ctx.loginAs('reviewer')),
        },
        {
            name: 'Reviewer requests a revision',
            run: ctx =>
                ctx.step(async () => {
                    await submitProposalDecision(
                        ctx,
                        /^Request revision$/i,
                        /^Request revision$/i,
                        content(ctx).changeRequestFeedback
                    )
                    await statusAlert(ctx, /Revision requested/i).waitFor({ state: 'visible' })
                }),
        },
        {
            name: 'Switch back to the researcher account',
            run: ctx => ctx.step(() => ctx.loginAs('researcher')),
        },
        {
            name: 'Researcher sees the revision request and opens Edit proposal',
            run: ctx =>
                ctx.step(async () => {
                    await gotoSubmitted(ctx)
                    await statusAlert(ctx, /Revision requested/i).waitFor({ state: 'visible' })
                    const editHeading = ctx.page.getByRole('heading', {
                        level: 2,
                        name: 'Edit proposal',
                    })
                    await clickUntil(
                        ctx.page.getByRole('link', { name: /^Edit proposal$/i }),
                        editHeading
                    )
                    // The reviewer's feedback is shown on the page the researcher edits on.
                    await expect(
                        ctx.page.getByText(content(ctx).changeRequestFeedback)
                    ).toBeVisible()
                    // The saved proposal is loaded for editing, not blank fields.
                    await expect(ctx.page.getByLabel('Research question(s)')).toContainText(
                        content(ctx).researchQuestion
                    )
                }),
        },
        {
            name: 'Resubmitting without a note is blocked',
            run: ctx =>
                ctx.step(async () => {
                    await ctx.page.getByRole('button', { name: /^Resubmit proposal$/i }).click()
                    await expect(ctx.page.getByText(NOTE_REQUIRED)).toBeVisible()
                    await expect(ctx.page.getByRole('dialog')).toBeHidden()
                }),
        },
        {
            name: 'Researcher revises the proposal and resubmits it with a note',
            run: ctx =>
                ctx.step(async () => {
                    const question = ctx.page.getByLabel('Research question(s)')
                    await question.click()
                    await ctx.page.keyboard.press('ControlOrMeta+A')
                    await ctx.page.keyboard.type(revisedQuestion(ctx))
                    await expect(question).toHaveText(revisedQuestion(ctx))

                    await fillLexical(ctx.page, 'Resubmission note', content(ctx).resubmissionNote)
                    await expect(ctx.page.getByText(NOTE_REQUIRED)).toBeHidden()

                    await clickUntil(
                        ctx.page.getByRole('button', { name: /^Resubmit proposal$/i }),
                        ctx.page.getByRole('dialog', { name: 'Resubmit your proposal?' })
                    )
                    await confirmDialog(ctx, /^Resubmit proposal$/i)
                    // v2.0 proves this is the resubmission, not round 1's banner.
                    await statusAlert(ctx, /Proposal v2\.0 resubmitted to/i).waitFor({
                        state: 'visible',
                    })
                }),
        },
        {
            name: 'Switch to the reviewer account',
            run: ctx => ctx.step(() => ctx.loginAs('reviewer')),
        },
        {
            name: 'Reviewer sees the revised proposal and the resubmission note',
            run: ctx =>
                ctx.step(async () => {
                    await gotoReview(ctx, id(ctx))
                    await ctx.page
                        .getByRole('button', { name: /^Submit decision$/i })
                        .waitFor({ state: 'visible' })
                    await expect(ctx.page.getByText(revisedQuestion(ctx))).toBeVisible()
                    await expect(ctx.page.getByText(content(ctx).resubmissionNote)).toBeVisible()
                }),
        },
        {
            name: 'Reviewer declines the proposal',
            run: ctx =>
                ctx.step(async () => {
                    await submitProposalDecision(
                        ctx,
                        /^Decline and end study$/i,
                        /^Decline and end study$/i,
                        declineFeedback(ctx)
                    )
                    await statusAlert(ctx, /Proposal declined/i).waitFor({ state: 'visible' })
                }),
        },
        {
            name: 'Switch back to the researcher account',
            run: ctx => ctx.step(() => ctx.loginAs('researcher')),
        },
        {
            name: 'Researcher sees the decline and can no longer edit the proposal',
            run: ctx =>
                ctx.step(async () => {
                    await gotoSubmitted(ctx)
                    await statusAlert(ctx, /Proposal declined/i).waitFor({ state: 'visible' })
                    await expect(ctx.page.getByText(declineFeedback(ctx))).toBeVisible()
                    await expect(
                        ctx.page.getByRole('link', { name: /^Edit proposal$/i })
                    ).toHaveCount(0)
                    // The route itself refuses a study that is no longer CHANGE-REQUESTED.
                    await ctx.page.goto(
                        `${ctx.baseURL}/${RESEARCHER_ORG}/study/${id(ctx)}/edit-and-resubmit`,
                        { waitUntil: 'domcontentloaded' }
                    )
                    await ctx.page
                        .getByRole('heading', { level: 1, name: 'Page Not Found' })
                        .waitFor({ state: 'visible' })
                }),
        },
        {
            name: 'Switch to the admin account for cleanup authority',
            run: ctx => ctx.step(() => ctx.loginAs('admin')),
        },
    ],
}
