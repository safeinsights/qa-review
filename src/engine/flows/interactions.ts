import { expect, type Locator } from '@playwright/test'

// Shared browser-interaction primitives: the ones whose failure mode belongs to the
// app SHELL — hydration, client-rendered controls — rather than to any one flow, and
// so kept in one place instead of re-derived per suite.

// Ceiling for the whole click-until-ready loop below. Generous against the ~0.5-1s a
// slow control actually takes on qa, so it never trims a slow-but-working load; it
// exists only so a target that NEVER becomes ready fails the step instead of polling
// forever.
//
// It has to be a number, and this is the one sanctioned inline Playwright timeout in
// the suites (see "Code rules" in CLAUDE.md). Under Playwright's LIBRARY mode a bare
// `toPass()` resolves its timeout to
// `options.timeout ?? expectConfig().toPass?.timeout ?? 0` — with no test runner
// there is no config to read, so it polls with NO deadline, and
// `expect.configure({ timeout })` does not fix it (toPass never consults that). The
// alternative to a number here is therefore not a longer wait, it is an infinite
// one. `withStepDeadline` does still stop the run, but five minutes later and with a
// message naming the STEP rather than the control that never came alive.
export const CLICK_UNTIL_READY_TIMEOUT_MS = 60_000

// Click `control` until `target` is ready to be driven, re-clicking as it retries.
//
// One click is not enough in this app. Controls are server-rendered, so they are
// present and clickable BEFORE React wires their onClick: the click lands on a dead
// button, it takes focus, nothing opens, and the caller then burns its entire action
// timeout waiting for a dialog that was never going to appear. A click landing before
// the page hydrates can also navigate outside the router's knowledge and be undone.
//
// "Ready" is visible AND enabled, not merely visible, because a Mantine control
// renders DISABLED while its data loads. Handing the caller a control it cannot click
// only moves the failure one line down: the click logs "element is not enabled", then
// "element was detached from the DOM" once the loaded node replaces it, and never
// recovers. Playwright treats anything that cannot be disabled as enabled, so the
// stricter wait costs non-form targets (dialogs, popovers) nothing.
export async function clickUntil(
    control: Locator,
    target: Locator,
    timeoutMs: number = CLICK_UNTIL_READY_TIMEOUT_MS
): Promise<void> {
    await expect(async () => {
        // Re-drive the control only while clicking it can still accomplish something.
        // A control that navigates away DETACHES on success, so an unconditional
        // re-click would spend the rest of the budget timing out on a dead locator
        // instead of waiting out a slow target; and once the target is attached the
        // click has already worked, so repeating it risks undoing it (a second click
        // on a link that navigated, a toggle closing what it just opened).
        const arrived = (await target.count()) > 0
        if (!arrived && (await control.count()) > 0) await control.click()
        await expect(target).toBeVisible()
        await expect(target).toBeEnabled()
    }).toPass({ timeout: timeoutMs })
}
