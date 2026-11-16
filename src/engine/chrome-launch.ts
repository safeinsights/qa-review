import type { LaunchOptions } from '@playwright/test'

// Production Clerk's hosted sign-in (accounts.safeinsights.org) sits behind a
// Cloudflare bot check that QA/staging do not have. Playwright's default launch
// marks the browser as automated (`--enable-automation`, `navigator.webdriver`
// true), which Cloudflare reads as a bot and answers with an interactive
// challenge the suite cannot pass. Dropping both signals lets the real
// installed Chrome look like an ordinary one.
export function chromeLaunchOptions(extra: LaunchOptions = {}): LaunchOptions {
    return {
        channel: 'chrome',
        ...extra,
        ignoreDefaultArgs: ['--enable-automation'],
        args: ['--disable-blink-features=AutomationControlled', ...(extra.args ?? [])],
    }
}
