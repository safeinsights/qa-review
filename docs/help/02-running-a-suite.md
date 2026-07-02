# Running a suite

Running a suite means: pick a test, choose where it runs, and press **Run**. The
runner opens a browser and steps through the test for you.

## Step by step

1. **Pick a suite.** Choose one from the suite list (for example `signin` or
   `create-study`). As soon as you pick it, you'll see the list of steps it will
   perform *before* it runs — so you know what to expect.
2. **Role is chosen for you.** Each suite already knows which kind of account it
   needs (researcher, reviewer, admin…). When you pick a suite, the **ROLE** is
   set automatically and locked — the label shows *(FROM SUITE)*. You don't need
   to change it.
3. **Choose where to run.** Pick an environment:
   - **QA** or **Staging** — the stable shared environments.
   - **A PR preview** — to test a specific pull request, enter its number. This
     runs the *exact same* test against that PR's preview site; nothing else
     changes.
4. **Press Run.**

## Watching the run

- The **step checklist** ticks off each step as it passes. A green check means
  done; a red mark means that step failed.
- The **live browser** on the right shows what the test is actually doing.
- When the run finishes you can review screenshots, a video recording, and a
  trace of everything that happened.

## Pausing and failures

- You can tell a run to **pause before a step** — handy when you want to inspect
  the browser at a certain point. The run stops there and holds the browser open
  until you press **Resume**.
- **If a step fails**, the run stops and *holds the browser open* on the failure
  so you can see exactly what state it was in. From there you can **Retry** the
  step (useful after a fix) or **Give up** to end the run.

## Ask Claude

While a run is paused or stopped on a failure, the **Ask Claude** button opens a
helper that can look at the frozen browser with you, explain what went wrong, and
even suggest or make a fix to the suite. It can only drive the browser while the
run is paused or failed (not mid-step).

## A failed run isn't your fault

A suite failing usually means it found a real problem in the app, or the test
environment's data isn't in the expected state — not that you did something
wrong. If a run does nothing at all or fails to start, see *Troubleshooting*.
