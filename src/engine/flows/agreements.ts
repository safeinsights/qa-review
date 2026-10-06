import { expect, type Page } from '@playwright/test'

// Study and org agreements raise the same modal over the page (it intercepts every
// click beneath it): a link to the agreement, an acknowledgement box, and a Continue
// that stays disabled until the box is ticked — asserted both ways, so a Continue that
// skipped the acknowledgement would fail here.
//
// `agreement` is the agreement's title as the modal prints it, e.g. "Study Agreement"
// or "Data Organization Participation Agreement". The dialog is matched by that text
// rather than by accessible name, so a modal whose title is not wired up as its label
// is still found.
export async function acknowledgeAgreement(page: Page, agreement: string): Promise<void> {
    const modal = page.getByRole('dialog').filter({ hasText: agreement })
    await modal.waitFor({ state: 'visible' })
    await expect(modal.getByRole('link', { name: agreement })).toBeVisible()
    const proceed = modal.getByRole('button', { name: 'Continue', exact: true })
    await expect(proceed).toBeDisabled()
    await modal
        .getByRole('checkbox', { name: `I have read and acknowledge the ${agreement}` })
        .check()
    await expect(proceed).toBeEnabled()
    await proceed.click()
    await expect(modal).toBeHidden()
}
