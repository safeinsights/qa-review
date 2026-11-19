import { chromium } from '@playwright/test'
import { describe, expect, it } from 'vitest'
import { chromeLaunchOptions } from '@/engine/chrome-launch'
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
    // The browser is launched inside the test, not in a beforeAll: a cold Chrome start on a
    // CI runner outlasts vitest's hook timeout, while tests get the global testTimeout.
    it('matches exactly the input on every shape of the field', async () => {
        const browser = await chromium.launch(chromeLaunchOptions())
        try {
            const page = await browser.newPage()
            for (const [shape, html] of Object.entries(SHAPES)) {
                await page.setContent(html)
                const matched = await piSelect(page).evaluateAll(els => els.map(el => el.tagName))
                expect(matched, shape).toEqual(['INPUT'])
            }
        } finally {
            await browser.close()
        }
    })
})
