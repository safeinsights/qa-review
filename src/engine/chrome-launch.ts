import type { Browser, BrowserContext, LaunchOptions } from '@playwright/test'

// Production Clerk's hosted sign-in (accounts.safeinsights.org, which Coder's OIDC
// sends Launch IDE through) sits behind a Cloudflare bot check that QA/staging do not
// have. Playwright's default launch marks the browser as automated
// (`--enable-automation`, `navigator.webdriver` true). Dropping both signals costs
// nothing, but on its own it does NOT clear the challenge — see chromeContext.
export function chromeLaunchOptions(extra: LaunchOptions = {}): LaunchOptions {
    return {
        channel: 'chrome',
        ...extra,
        ignoreDefaultArgs: ['--enable-automation'],
        args: ['--disable-blink-features=AutomationControlled', ...(extra.args ?? [])],
    }
}

// The browser's own user agent with "HeadlessChrome" put back to "Chrome".
async function unheadedUserAgent(browser: Browser): Promise<string> {
    const probe = await browser.newPage()
    try {
        const agent = await probe.evaluate(() => navigator.userAgent)
        return agent.replace('HeadlessChrome/', 'Chrome/')
    } finally {
        await probe.close()
    }
}

// A context whose user agent does not say "HeadlessChrome". That word is what
// Cloudflare challenges on: loading the production portal's sign-in page (Nov 17 2026)
// stuck on "Just a moment..." for headless Chrome with and without the automation
// flags, and passed for headless Chrome with this user agent, as it did for a visible
// window even with navigator.webdriver still true. Every qar browser is headless, the
// session browser the GUI streams included. Playwright derives the client-hint brands
// from the override too, so they read "Google Chrome" rather than "HeadlessChrome".
export async function chromeContext(
    browser: Browser,
    options: Parameters<Browser['newContext']>[0] = {}
): Promise<BrowserContext> {
    return browser.newContext({ userAgent: await unheadedUserAgent(browser), ...options })
}
