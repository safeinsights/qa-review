import { expect, type Page } from '@playwright/test'

// Mantine's public class names for a notification. `role=alert` alone is NOT specific enough
// to find a toast: the App Router mounts its own permanently-empty `div[role=alert]` route
// announcer. Shared so the class names live in ONE place — they are the part most likely to
// move under a Mantine upgrade, and a suite that silently stops finding toasts would keep
// passing while asserting nothing.
export const TOAST = '.mantine-Notification-root'
export const TOAST_TITLE = '.mantine-Notification-title'
export const TOAST_BODY = '.mantine-Notification-description'
export const TOAST_CLOSE = '.mantine-Notification-closeButton'

// Clear the tray so a still-open toast can neither satisfy the next assertion nor cover a
// control. Mantine holds a notification for 8s, which is long enough for two consecutive
// saves of the SAME card to fall inside one window — so without this, the second save's
// assertion is satisfied by the first save's toast and proves nothing.
//
// Clicking each close button beats waiting out the autoClose; the clicks are best-effort
// (one can hit autoClose mid-loop, detaching the node), and `toHaveCount(0)` is the real gate.
export async function dismissToasts(page: Page): Promise<void> {
    for (const closeButton of await page.locator(TOAST_CLOSE).all()) {
        await closeButton.click().catch(() => {})
    }
    await expect(page.locator(TOAST)).toHaveCount(0)
}

// "This toast came up, with this title" — for suites whose subject is the ACTION rather than
// the notification. The exhaustive checks (severity colour, role, the absence of a title on
// the message-only notices) belong to the toast-messages suite, which owns that surface.
//
// `message` is optional because a real call site passes none: use-submit-proposal raises
// 'Proposal submitted' with `message: ''`. Mantine renders the description element ANYWAY —
// unlike the title, the description Box carries no `children &&` guard — so the empty case is
// asserted as EMPTY TEXT rather than as an absent node. `toHaveCount(0)` here would fail against
// a toast behaving exactly as written.
export async function expectToastVisible(
    page: Page,
    expected: { title: string; message?: string }
): Promise<void> {
    // Matched on the TITLE ELEMENT, not on `hasText`. `hasText` matches anywhere in the
    // notification — title or body — and is not anchored, so with two toasts open inside
    // Mantine's 8s window the assertions below hit a strict-mode violation naming the locator
    // rather than the leftover toast. Callers here do not clear the tray first.
    const toast = page
        .locator(TOAST)
        .filter({ has: page.locator(TOAST_TITLE, { hasText: expected.title }) })
    // waitFor, not expect, for the appearance: these toasts are raised on a server round trip,
    // which needs the action timeout rather than the shorter assertion one. (Timeouts are
    // configured globally, never inline.)
    await toast.waitFor({ state: 'visible' })
    await expect(toast.locator(TOAST_TITLE)).toHaveText(expected.title)
    if (expected.message) {
        await expect(toast.locator(TOAST_BODY)).toHaveText(expected.message)
    } else {
        await expect(toast.locator(TOAST_BODY)).toHaveText('')
    }
}
