import { type Browser, chromium, type Page } from '@playwright/test'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { piSelect } from '@/engine/flows/study'

// The Principal Investigator field comes in three shapes, and on QA its open option list
// carries the same aria-label as the input. These pages copy the attributes each release
// renders, so the locator is checked against the roles and names the app really exposes.
const SHAPES = {
    // QA since Nov 12 2026: a combobox, plus a listbox labelled like the field once opened.
    qa: `<label for="piName">Principal Investigator</label>
<input id="piName" role="combobox" aria-haspopup="listbox" aria-expanded="true">
<div role="listbox" aria-label="Principal Investigator"><div role="option">Test Admin User</div></div>`,
    // Production v1.7.1: a plain textbox.
    production: `<label for="piName">Principal Investigator</label><input id="piName" type="text">`,
    // Staging: the Mantine Select input with aria-haspopup and no role.
    staging: `<label for="piName">Principal Investigator</label><input id="piName" aria-haspopup="listbox">`,
}

describe('piSelect', () => {
    let browser: Browser
    let page: Page

    beforeAll(async () => {
        browser = await chromium.launch({ channel: 'chrome', headless: true })
        page = await browser.newPage()
    })
    afterAll(async () => {
        await browser?.close()
    })

    for (const [shape, html] of Object.entries(SHAPES)) {
        it(`matches exactly the input on the ${shape} shape`, async () => {
            await page.setContent(html)
            await expect(piSelect(page).count()).resolves.toBe(1)
            await expect(piSelect(page).evaluate(el => el.tagName)).resolves.toBe('INPUT')
        })
    }
})
