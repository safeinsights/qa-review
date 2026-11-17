import { chromium } from '@playwright/test'
import { describe, expect, it } from 'vitest'
import { chromeContext, chromeLaunchOptions } from '@/engine/chrome-launch'

describe('chromeLaunchOptions', () => {
    it('drops the automation flags Cloudflare reads as a bot', () => {
        const opts = chromeLaunchOptions()
        expect(opts.channel).toBe('chrome')
        expect(opts.ignoreDefaultArgs).toEqual(['--enable-automation'])
        expect(opts.args).toContain('--disable-blink-features=AutomationControlled')
    })

    it('keeps caller args and options alongside the anti-bot flags', () => {
        const opts = chromeLaunchOptions({
            headless: false,
            args: ['--remote-debugging-port=9222'],
        })
        expect(opts.headless).toBe(false)
        expect(opts.args).toEqual([
            '--disable-blink-features=AutomationControlled',
            '--remote-debugging-port=9222',
        ])
    })
})

// "HeadlessChrome" in the user agent is what the production portal's Cloudflare
// challenges on; the flags above alone left it stuck on "Just a moment...".
describe('chromeContext', () => {
    it('gives a headless browser a user agent and brands that do not say Headless', async () => {
        const browser = await chromium.launch(chromeLaunchOptions())
        try {
            const page = await (await chromeContext(browser)).newPage()
            const seen = await page.evaluate(() => ({
                agent: navigator.userAgent,
                brands: (
                    navigator as unknown as { userAgentData?: { brands: { brand: string }[] } }
                ).userAgentData?.brands.map(b => b.brand),
                webdriver: navigator.webdriver,
            }))
            expect(seen.agent).toMatch(/ Chrome\/\d/)
            expect(seen.agent).not.toMatch(/Headless/i)
            expect(seen.brands?.join(',') ?? '').not.toMatch(/Headless/i)
            expect(seen.webdriver).toBe(false)
        } finally {
            await browser.close()
        }
    })

    it('keeps the caller options it is given', async () => {
        const browser = await chromium.launch(chromeLaunchOptions())
        try {
            const context = await chromeContext(browser, { baseURL: 'https://example.test' })
            const page = await context.newPage()
            await page.route('https://example.test/**', r => r.fulfill({ body: 'ok' }))
            await page.goto('/probe')
            expect(page.url()).toBe('https://example.test/probe')
        } finally {
            await browser.close()
        }
    })
})
