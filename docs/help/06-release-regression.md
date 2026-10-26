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
   runner does the baseline suite first. Then a session goes through each line
   of the plan in the browser. At the end, the results are checked and
   uploaded.

## Where the files go

The plan and the results are assets on the GitHub release of the management
app. The plan is `regression-plan.md`. A result file is named
`regression-results-<env>-<date>-<time>.md`. Passwords and login codes are
removed from the result file before it is saved.

## Test lines and "(staging only)"

Each test line starts with an ID in brackets, for example `[R-123-1]`. A line
that ends with **(staging only)** changes data or probes the system. Do not run
it on production. On production, the app does not accept a PASS or FAIL for
that line.

## Why Save is disabled

- **You cannot push to the management-app repository.** Saving adds a file to
  the release. You need the push right. Ask a teammate who has it to save the
  plan.
- **The plan has a problem.** A test line can be wrong, for example a bad
  bracket token in a section. The editor shows the problem. Fix the line.
- **The editor has unsaved keystrokes.** Wait one moment. The app saves your
  typing to the local file first.

## Regenerate overwrites your local plan

**Regenerate** builds the plan again from the pull requests. It replaces the
local plan. Your edits to the local plan are lost. Save the plan to the release
first if you want to keep it.

## Production needs one more secret

The baseline suite runs the full study lifecycle. For production, the secret
`RESEARCHER_RESULTS_PRIVATE_KEY_PRODUCTION` must be set. Without it, the run
stops. See *Keyring & access*.
