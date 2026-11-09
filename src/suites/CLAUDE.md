# src/suites/ — notes for individual suites

(Moved from the root CLAUDE.md, which still holds the repo-wide rules.)

## Lighthouse audits (the `lighthouse` suite)

Records a Lighthouse score per key page plus an overall average, so performance and
accessibility regressions surface as a trend rather than by accident.

**Chrome does NOT expose Lighthouse over CDP.** The Lighthouse panel in DevTools is
DevTools' own bundled copy of the Lighthouse JS — there is no `Lighthouse.*` CDP
domain, and Playwright has no Lighthouse API. So a real audit needs the **npm
`lighthouse` package**. What Playwright provides is the BROWSER: `launchChromeWithCdp`
already starts Chrome with `--remote-debugging-port`, and lighthouse attaches to that
port by number — so the audit runs against the same **already-authenticated** session
the steps drive, not a fresh profile. (`disableStorageReset: true` keeps it that way;
a reset would bounce the audit to the sign-in page.)

Three constraints follow, each of which will break the packaged app if forgotten:

- **`lighthouse` is `external` in `esbuild.config.mjs`.** It does computed `require()`
  of its audits/gatherers and reads report templates + locale JSON relative to
  `import.meta.url`. esbuild cannot resolve any of that statically, so an inlined copy
  builds fine and then throws at audit time. It ships as a real tree in
  `Resources/engine/node_modules`, staged by `scripts/build-app.sh` exactly like
  Playwright.
- **Lighthouse 13 declares `engines.node >= 22.19`**, so `NODE_VERSION` in
  `scripts/build-app.sh` is a hard floor, not a preference. A dev checkout runs on the
  system node and stays green while the `.app` dies at `import('lighthouse')`, so this
  only shows up in a packaged smoke test.
- The suite needs a **CDP port**, which `--headed` does not provide (`run-headed.ts`
  launches without one). `requireCdpPort` fails naming `--screencast`; the GUI always
  passes it.
- **`qar sync` does NOT install dependencies** — it is a `git pull` and nothing else,
  and that is correct: in the packaged app `node_modules` is a symlink INTO the signed
  `.app`, so an install there would write into the bundle. This suite is the first one
  to need a dependency the app does not already ship, so it is also the first that a
  sync alone cannot make runnable. A synced clone can therefore hold the suite while
  the `.app` running it predates `lighthouse`; the fix is a new build, NOT an install.
  A dev checkout just needs `pnpm install`. `loadLighthouse()` turns Node's
  `Cannot find package 'lighthouse'` into a message naming both cases — the package
  name alone would repeat the stale-clone class of failure that named neither the app
  nor the staleness. **A future suite that adds a dependency inherits all of this.**

**Report-only by design.** A step fails only when the audit itself fails — never
because a score is low. Two back-to-back runs against the same QA build scored
performance 91 then 90, so a threshold would produce exactly the flaky red the
"E2E flakiness: ZERO tolerance" rule forbids. The signal is the trend, not one number.
A `null` category is a failure rather than a 0: scoring it 0 would read as "the app is
terrible" instead of "the audit broke".

Where the numbers go:

- `ctx.recordMetrics({...})` attaches numbers to the enclosing `ctx.step()`'s event
  (`StepEvent.metrics`), which the GUI renders as a chip beside the step's duration.
  It is an open `Record<string, number>`, so the recorder stays ignorant of what any
  one suite measures. Metrics are cleared per step, and kept on a FAILED step — three
  of four categories is more debuggable than none.
- Each run writes `<bundle>/lighthouse/<route-slug>.report.{html,json}` plus a
  `summary.json`. The HTML is the full DevTools-style report; open it directly.
- `summary.json` deliberately does NOT repeat the env or a timestamp — both are
  already in the bundle directory name (`<stamp>_<suite>_<env>`), the one place they
  cannot drift out of sync. `ListLighthouseRuns` (`gui/lighthouse.go`) parses them
  from there, which is why `envFromBundleName` splits from the END (a suite name may
  itself contain underscores).
- The GUI's **Performance tab** plots the history. It is the only thing in the app
  that enumerates past bundles; bundles without a `summary.json` are skipped, since
  most runs are not Lighthouse runs. The y-axis is pinned to 0-100 rather than fitted
  to the data — a fitted axis turns a two-point wobble into a visual cliff.

Adding a route means adding it to `ROUTES` in `src/suites/lighthouse.ts` and updating
the pinned names in `tests/suites/step-names.test.ts`.
