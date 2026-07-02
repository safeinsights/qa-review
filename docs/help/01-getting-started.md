# Getting started

The **QA Runner** runs SafeInsights' automated browser tests ("suites") for you.
You pick a suite, press **Run**, and watch it drive a real browser through the
app — signing in, creating a study, and so on — reporting each step as it goes.

You don't need to write any code to run suites. This guide covers the basics.

## The three tabs

- **Suites** — the main screen. Choose a test suite, pick where to run it, and
  press Run. You'll see each step check off (or fail) in real time, with a live
  view of the browser.
- **Author a Suite** — a guided way to *create* a new suite by describing what
  you want tested. Claude drives a browser and writes the suite for you.
- **Settings** — the shared test accounts and passwords, plus your access setup.
  Most of the time you won't need to touch this.

## First launch

The very first time you open the app it needs two things:

1. **A place to keep its files.** It asks you to pick a folder, then downloads
   ("clones") the QA project into it. This holds the suites and configuration.
   You only do this once.
2. **Access to the shared secrets.** The suites sign in as real test accounts,
   whose passwords are encrypted so only approved teammates can read them. If
   you're new, press **Request access** and a teammate approves you. See
   *Keyring & access* for what this means.

Once those are done, you land on the **Suites** tab and can run anything.

## Keeping up to date

Suites and settings change over time. The **Sync** button at the top pulls the
latest. See *Syncing updates*.

## When something goes wrong

If a run won't start, a step fails unexpectedly, or you're just stuck, see
*Troubleshooting* — and remember the **Report issue** button in the header,
which files a bug with all the debugging details attached automatically.
