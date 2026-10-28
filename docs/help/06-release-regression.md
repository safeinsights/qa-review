# Release regression

The **Release** tab helps you test one release of the management app. It builds
a test plan for the release. You can edit the plan. Then it runs the plan on
staging or production and saves the results.

## The three phases

1. **Pick.** Choose a release tag, for example `v1.6.9`. If a plan was saved
   for this release before, the app opens it. No session starts.
2. **Plan.** A session reads every pull request in the release. It writes a
   plan with these sections: Summary, Baseline, Changes, Security, and
   Technical appendix. You edit the plan in the editor. The session and you can
   both change the plan. When the session changes it, the editor reloads. Your
   cursor stays in place. If you have unsaved edits, the app asks you what to do.
3. **Run.** Choose **staging** or **production** and press **Start run**. The
   app runs the baseline suite first and shows each step, for example
   "Baseline: step 5/34". Then a session goes through each line of the plan in
   the browser. A failed baseline does not stop the run. At the end, the
   results are checked and uploaded.

## Where the files go

The plan and the results are assets on the GitHub release of the management
app. The plan is `testing-plan.md`. A result file is named
`regression-results-<env>-<date>-<time>.md`. Passwords, login codes, private
keys, tokens and other secrets are removed from the result file before it is
saved.

## Security lines stay on your computer

The management-app repository is public. Anyone can read its release assets.
For this reason, the Security section of the plan is never uploaded:

- When you save the plan, the app removes the Security section from the
  uploaded copy. Your local plan keeps it. The app does not upload a file that
  contains security lines.
- The security lines run on staging only, and only on the computer that has
  the local plan.
- Their results go to a local file, `security-results-<env>.md`. The session
  shows them to you in the terminal. They are not uploaded. If you ask, the
  session can put them on one Jira card.

## Test lines and "(staging only)"

Each test line starts with an ID in brackets, for example `[R-123-1]`. A line
that ends with **(staging only)** changes data or probes the system. Do not run
it on production. On production, the app does not accept a PASS or FAIL for
that line.

## Why Save is disabled

- **No session is live.** Save tells the plan session to upload the plan. If no
  session is live, nothing can do the upload. Press **Start session** (or
  **Retry**) first.
- **You cannot push to the management-app repository.** Saving adds a file to
  the release. You need the push right. Ask a teammate who has it to save the
  plan.
- **The plan has a problem.** A test line can be wrong, for example a bad
  bracket token in a section. The editor shows the problem. Fix the line.
- **The editor has unsaved keystrokes.** Wait one moment. The app saves your
  typing to the local file first.

## Why Run is disabled

- **The local plan has unsaved edits.** A run uses the plan on the release.
  Save or discard your edits first, or the run does not test them.
- **You cannot push to the management-app repository.** A run uploads its
  results. You need the push right.

## If the session stops before the plan exists

Press **Retry**. The new session continues the work. It uses the pull request
notes that the first session already wrote.

## Regenerate overwrites your local plan

**Regenerate** builds the plan again from the pull requests. It replaces the
local plan. Your edits to the local plan are lost. Save the plan to the release
first if you want to keep it.

## Production needs one more secret

The baseline suite runs the full study lifecycle. For production, the secret
`RESEARCHER_RESULTS_PRIVATE_KEY_PRODUCTION` must be set. Without it, the run
stops. See *Keyring & access*.
