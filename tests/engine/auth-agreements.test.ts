import { type Browser, chromium, type Page } from '@playwright/test'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { acceptOwedAgreements, owedAgreementsCheckbox, signedInMarker } from '@/engine/auth'

// management-app #1331 moved the ToS/PN acknowledgement to a full page that a signed-in
// account is redirected to before any app page renders. loginAs waited only for the
// side-nav "My studies" link, so every sign-in of an account owing a new version timed
// out — on QA that is every shared account, after every publish. These pages copy the
// step's accessible structure (heading, one checkbox, Continue disabled until it is
// ticked) so the helpers are driven against the same roles and names the app renders.

const agreementsPage = (label: string, wireAfterMs = 0) => `
<main>
  <h1>Welcome to SafeInsights!</h1>
  <p>We have updated our <a href="/legal?tab=TOS" target="_blank">Terms of Service</a>. Please review before proceeding.</p>
  <label><input type="checkbox" id="agree"> ${label}</label>
  <button id="continue" disabled>Continue</button>
</main>
<script>
  const box = document.getElementById('agree')
  const button = document.getElementById('continue')
  // The app's checkbox renders before React wires it; an early tick is lost on
  // re-render. Model that by resetting the box until the handler is attached.
  setTimeout(() => {
    box.checked = false
    box.addEventListener('change', () => { button.disabled = !box.checked })
    button.addEventListener('click', () => {
      document.body.innerHTML = '<nav aria-label="Main"><a href="/dashboard">My studies</a></nav><main><h1>My studies</h1></main>'
    })
  }, ${wireAfterMs})
</script>`

describe('the full-page ToS/PN step at sign-in', () => {
    let browser: Browser
    let page: Page

    beforeAll(async () => {
        browser = await chromium.launch({ channel: 'chrome', headless: true })
    })
    afterAll(async () => {
        await browser?.close()
    })

    const open = async (html: string) => {
        page = await browser.newPage()
        await page.setContent(html)
        return page
    }

    it('ticks the box, presses Continue and lands signed in', async () => {
        await open(agreementsPage('I have read and agree to the updated Terms of Service.'))
        await acceptOwedAgreements(page)
        await expect(signedInMarker(page).isVisible()).resolves.toBe(true)
        await page.close()
    })

    it('keeps ticking until the checkbox is wired, so an early tick is not lost', async () => {
        await open(agreementsPage('I have read and agree to the updated Privacy Notice.', 1_500))
        await acceptOwedAgreements(page)
        await expect(signedInMarker(page).isVisible()).resolves.toBe(true)
        await page.close()
    })

    it('recognises all six variants of the step', async () => {
        // "updated " appears only when the account acknowledged an earlier version of
        // every owed document; a first publish or a never-acknowledged one drops it.
        for (const label of [
            'I have read and agree to the updated Terms of Service.',
            'I have read and agree to the updated Privacy Notice.',
            'I have read and agree to the updated Terms of Service and Privacy Notice.',
            'I have read and agree to the Terms of Service.',
            'I have read and agree to the Privacy Notice.',
            'I have read and agree to the Terms of Service and Privacy Notice.',
        ]) {
            await open(agreementsPage(label))
            await expect(owedAgreementsCheckbox(page).count()).resolves.toBe(1)
            await page.close()
        }
    })

    it('does not mistake the ROPA/DOPA modal or the signup boxes for the step', async () => {
        // Those stay the caller's business: accepting an org agreement or a signup's
        // terms on someone's behalf is not part of signing in.
        for (const label of [
            'I have read and acknowledge the updated Research Organization Participation Agreement.',
            'I agree to the Terms of Service and Privacy Notice',
        ]) {
            await open(agreementsPage(label))
            await expect(owedAgreementsCheckbox(page).count()).resolves.toBe(0)
            await page.close()
        }
    })
})
