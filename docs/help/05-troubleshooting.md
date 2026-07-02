# Troubleshooting

Most problems fall into a few buckets. Work down this list.

## "The run does nothing" — no steps appear after pressing Run

Usually a required password or setting is missing, so the runner exits
immediately. Check:

- **Do you have keyring access?** If you're not approved yet, the shared
  passwords can't be decrypted and the run stops before it starts. See *Keyring
  & access* and press **Request access**.
- **Have you synced?** Press **Sync** to pull the latest settings, then try
  again.
- Still stuck? Use **Report issue** — it captures the exact error for the team.

## A "missing password" or "missing secret" error

The runner needs an account password or login code it can't find. This almost
always means either you're not yet a keyring recipient, or the secrets haven't
been re-encrypted to include you. **Sync**, and if it persists, ask a teammate to
re-approve/rekey. See *Keyring & access*.

## The Setup Doctor

The app relies on a few tools from your machine (a browser, git, and a couple of
command-line tools). If one is missing, you'll see a banner. The **Setup Doctor**
checks each prerequisite and tells you exactly what's missing and how to fix it.
Run it whenever the app complains about setup.

## A suite fails partway through

This is often a *real* finding — the app under test behaved unexpectedly, or the
environment's data isn't in the state the suite expects. The run holds the
browser open on the failure so you can inspect it, and you can press **Ask
Claude** to help diagnose. A failure on a PR but not on QA (or vice-versa) is
almost always an environment/data difference, not a problem with the suite.

## Still stuck? Report it

The **Report issue** button in the header files a bug on the project's GitHub
with your current run state and system details attached automatically. Give it a
short title and any notes — that's the fastest way to get help.
