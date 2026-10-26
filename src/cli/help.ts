interface CommandHelp {
    name: string
    usage: string
    summary: string
    details?: string
}

// Every subcommand name, as a union of literals rather than `string`. Derived from
// COMMANDS below (`as const satisfies`, which checks the shape without widening the
// names), so this list stays the single place a command is named. `booleansFor` keys
// its per-command switch sets by this type, which is what stops a typo there from
// silently resolving to "no switches for this command" — the failure mode that made
// `session-signin --password` swallow its value in the first place.
export type CommandName = (typeof COMMANDS)[number]['name']

// One entry per subcommand in bin/qar.ts. Keep this list in sync with the switch
// there — `qar --help` is the discovery path for anyone who doesn't know the flags.
export const COMMANDS = [
    {
        name: 'run',
        usage: 'qar run --suite <name> (--env <env> | --pr <n>) [--role <role>] [--headed] [--json]',
        summary: 'Run a suite against an environment or a PR preview.',
    },
    {
        name: 'login',
        usage: 'qar login --role <role> (--env <env> | --pr <n>) [--headed]',
        summary: 'Log in as a role in a one-off browser (not the shared session).',
    },
    {
        name: 'cleanup',
        usage: 'qar cleanup (--env <env> | --pr <n>) --token <jwt> [--studies <ids>] [--users <ids>]',
        summary: 'Delete test studies/users via the QA endpoints.',
        details: 'Needs an ADMIN Clerk session JWT; a 404 counts as already-gone.',
    },
    {
        name: 'codegen',
        usage: 'qar codegen [--url <url>]',
        summary: "Open Playwright's codegen recorder.",
    },
    { name: 'list', usage: 'qar list', summary: 'List available suites and their roles.' },
    {
        name: 'migrate',
        usage: 'qar migrate',
        summary: 'Import a legacy .env into config/settings.local.json.',
    },
    {
        name: 'request-access',
        usage: 'qar request-access --name "Your Name"',
        summary: 'Generate a local age identity and open a keyring PR.',
    },
    {
        name: 'access-status',
        usage: 'qar access-status [--json]',
        summary: 'Report the state of your keyring access request.',
        details:
            'States: no-identity, no-branch, branch-no-pr, pr-open, pr-closed, merged-awaiting-rekey, ready.',
    },
    {
        name: 'open-access-pr',
        usage: 'qar open-access-pr',
        summary: 'Open (or report) the pull request for an already-pushed access branch.',
    },
    {
        name: 'rekey',
        usage: 'qar rekey',
        summary: 'Re-encrypt all secrets to the current keyring (reviewer step).',
    },
    {
        name: 'set-secret',
        usage: 'qar set-secret --name <VAR> --value <value>',
        summary: 'Encrypt one secret to every keyring recipient.',
    },
    {
        name: 'get-secret',
        usage: 'qar get-secret --name <VAR> [--force]',
        summary: 'Print one decrypted secret to stdout (the read half of set-secret).',
        details:
            'The var is named with --name, not --key: --key is listed valueless for this\n' +
            'command, so it cannot carry a var name. Passing it is an error, not an alias.\n\n' +
            'Prints the raw value with NO trailing newline, so a PEM survives byte-for-byte:\n' +
            '  qar get-secret --name REVIEWER_RESULTS_PRIVATE_KEY_QA > reviewer-qa.pem\n\n' +
            'Refuses to write to a terminal unless --force is given, so a private key does\n' +
            'not land in scrollback. *.pem is gitignored, but delete the extracted file when\n' +
            "done anyway — it's a live results-decryption key on disk.",
    },
    {
        name: 'sync',
        usage: 'qar sync',
        summary: 'Fast-forward-only git pull (suites + keyring + secrets).',
    },
    {
        name: 'share-work',
        usage: 'qar share-work [--description "what changed"]',
        summary: 'Commit local edits to a branch and open a PR, then return to a synced main.',
        details:
            'The alternative to discarding local edits when sync is skipped. Commits the whole\n' +
            'working copy (gitignored files — your age identity, settings.local.json — are\n' +
            'never staged), pushes, opens a PR, then checks out main and fast-forwards.\n' +
            'If the push fails it stops on the branch rather than stranding unpushed commits.',
    },
    {
        name: 'session',
        usage: 'qar session (--env <env> | --pr <n>)',
        summary: 'Start the long-lived authoring/validation browser session.',
        details:
            'ONLY ONE session may run at a time — they share a single request channel, so a\n' +
            'second would steal `session-*` requests and act on a browser you are not attached\n' +
            "to. Starting a second one now fails with the running session's pid. Stays alive\n" +
            'until SIGTERM/SIGINT.',
    },
    {
        name: 'session-login',
        usage: 'qar session-login --role <admin|researcher|reviewer>',
        summary: "Log the RUNNING session's browser in as a role.",
    },
    {
        name: 'session-signin',
        usage: 'qar session-signin --email <e> [--password <p>]',
        summary: "Sign the session's browser in as any account, stopping at the MFA code step.",
    },
    {
        name: 'session-create-user',
        usage: 'qar session-create-user --role <researcher|reviewer> [--print-mfa-secret]',
        summary: 'Invite + complete signup for a fresh user. Prints {"userId","email"}.',
        details: [
            '--print-mfa-secret also prints the account\'s base32 TOTP secret as "mfaSecret".',
            'That is what lets you sign back IN as the created user later: pair it with',
            '`qar totp --secret <secret>` for a live code (the password is the shared signup',
            'constant). Without the flag the secret is discarded and the account becomes',
            'unreachable once the session ends.',
            '',
            'The secret appears in the session output and any transcript of it, so pass the',
            'flag only when a sign-back-in is actually needed. These are disposable QA/PR',
            'accounts — delete them afterwards with `qar cleanup --users <id>`.',
        ].join('\n'),
    },
    {
        name: 'session-create-study',
        usage: 'qar session-create-study',
        summary: 'Submit a full study proposal. Prints {"studyId"}.',
    },
    {
        name: 'mail-inbox',
        usage: 'qar mail-inbox',
        summary: 'Print a fresh mail.tm address.',
    },
    {
        name: 'mail-wait',
        usage: 'qar mail-wait --address <addr>',
        summary: 'Wait for the invite email; print the signup URL.',
    },
    {
        name: 'totp',
        usage: 'qar totp (--secret <base32> | --role <role> [--env <env> | --pr <n>])',
        summary: 'Print the current 6-digit MFA code.',
        details:
            'With --secret, computes the code from a raw base32 seed. With --role, resolves ' +
            "the account's second factor from the settings files (--env defaults to qa).",
    },
    {
        name: 'invite',
        usage: 'qar invite (--role researcher|reviewer | --org <slug>) [--email <addr>] [--admin]',
        summary: 'Mint an invite via the QA API. Prints {"inviteUrl","email",…}.',
        details:
            'Returns the invite URL directly — no inbox, no waiting on email. The invited ' +
            'role is implied by the org. A generated address always starts with "qa" (the ' +
            'API refuses anything else). The signup SUITE still uses the real UI + email.',
    },
    {
        name: 'fix-account',
        usage: 'qar fix-account --role <role> [--env <env> | --pr <n>] [--password] [--key] [--yes]',
        summary: 'Reconcile a shared account with settings (password / results key).',
        details:
            'Pushes the password and/or the PUBLIC half of the stored results private key ' +
            'onto the account, fixing drift that would otherwise wrap results to a key we ' +
            "can't unwrap. Naming neither flag pushes both. Org memberships are never " +
            'touched. Prompts before writing unless --yes.',
    },
    {
        name: 'study-state',
        usage: 'qar study-state --study <id> [--env <env> | --pr <n>] [--status <s>] [--job-status <s>] [--result <file>] [--log <file>]',
        summary: "Set a study's status and/or attach results, without an enclave run.",
        details:
            'Reaching "results are back and awaiting review" normally needs a real run ' +
            "(minutes), and on a PR preview can't happen at all — there's no compute " +
            'backend. Files are sent as plaintext and encrypted server-side to the ' +
            'reviewing org, so that org needs a public key enrolled first (see ' +
            "fix-account). Artifacts attach to the study's LATEST job.",
    },
    {
        name: 'jira-comment',
        usage: 'qar jira-comment --issue <KEY> --body-file <path.md> [--images a.png,b.png] [--attach a.html,b.json] [--mention <accountId>]',
        summary: 'Post ONE Jira comment with screenshots embedded inline.',
        details:
            'Body is Markdown (headings, bold, lists, links). Use {{image:N}} to place an image ' +
            'inline, {expand:Title}…{expand} for a collapsed block, and {{mention}} (with ' +
            '--mention <accountId>) to @-mention someone so Jira notifies them. --attach uploads ' +
            'other files and appends an "Attachments:" line linking them. The last line is ' +
            'always "Posted by qa-review <version>" (git describe of the repo clone, which in the packaged app can be ahead of the bundled engine).',
    },
    {
        name: 'deployed-release',
        usage: 'qar deployed-release (--env <env> | --pr <n>)',
        summary: 'Print the management-app release an environment runs, from its /about page.',
        details:
            'Prints {"aboutUrl","label","kind":"commit|tag","ref","url","rows"}. "ref" is what ' +
            'to compare a PR merge commit against. Fails when the page has no "Release" row.',
    },
    {
        name: 'jira-delete-comment',
        usage: 'qar jira-delete-comment --issue <KEY> --ids <id1,id2>',
        summary: 'Delete Jira comments (404 = already gone = success).',
    },
    {
        name: 'jira-attachments',
        usage: 'qar jira-attachments --issue <KEY> [--download] [--dir <path>]',
        summary: "List a card's attachments; --download saves the text ones under .tmp/.",
        details:
            'jira_get_issue returns attachment metadata at best, never content. Text ' +
            'attachments (.md/.txt/.csv, or text/* mime) are saved; images are listed only.',
    },
    {
        name: 'jira-create-issue',
        usage: 'qar jira-create-issue --project <KEY> --summary <text> --body-file <path.md> [--type Bug] [--images a.png,b.png] [--link <PARENT>] [--link-type Relates]',
        summary:
            'Create a follow-up card with an ADF description, inline screenshots, and a link to its parent.',
        details:
            'Checks the issue type and link type exist before creating anything. Body is ' +
            'Markdown with {{image:N}} placeholders, like jira-comment. Prints {"key","url"}.',
    },
    {
        name: 'verdict-posted',
        usage: 'qar verdict-posted --issue <KEY> --result <validated|rejected>',
        summary: 'Tell the GUI a verdict was posted, so it hides the Verdict button.',
        details: 'Call right after posting a verdict comment + transition to Jira.',
    },
    {
        name: 'followup-advice',
        usage: 'qar followup-advice --input <path.json>',
        summary: 'Recommend how to route validation FAILs: send back, one card, or multiple cards.',
        details:
            'Input is the results file from results-check (FAIL entries are used), or ' +
            '{"fails":[{"id","severity":"blocker|major|minor","area"}]}. Any blocker → ' +
            'send-back; ≤3 FAILs or one area → one-card; otherwise multiple-cards.',
    },
    {
        name: 'inventory-render',
        usage: 'qar inventory-render --input <path.json> [--output <path.html>]',
        summary: 'Render a validation requirement inventory as a self-contained HTML page.',
        details:
            'Input is {"card","target","lines":[{"id","title","kind":"check|absence|context","text",' +
            '"source":{"type":"card|comment|attachment|figma|observed","ref","url?","page?","frame?",' +
            '"category?"},"conflictWith?"}]}. Default output is the input path with .html. ' +
            'Prints {"output","summary"}.',
    },
    {
        name: 'results-check',
        usage: 'qar results-check --inventory <path.json> --results <path.json> [--env <env>]',
        summary: 'Gate a validation report: every inventory line has one evidenced result.',
        details:
            'Results are {"results":[{"id","result":"PASS|FAIL|CONFLICT|UNCLEAR|NOT TESTED",' +
            '"evidence","severity?","area?","approvedBy?","decision?"}]}. FAIL needs severity and area; ' +
            'NOT TESTED needs approvedBy; a line with source type "observed" can only be a FAIL. ' +
            'Fails listing every gap; prints {"ok","counts"} when clean.' +
            ' With --env production, a line flagged stagingOnly cannot be PASS or FAIL.',
    },
    {
        name: 'plan-lines',
        usage: 'qar plan-lines --input <plan.md> --tag <tag> [--output <path.json>]',
        summary: 'Parse the [R-…]/[S-…] test lines out of a regression plan for results-check.',
        details:
            'Sections must be Summary, Baseline, Changes, Security, Technical appendix in that ' +
            'order. A line is "- [ID] <title> — <steps>", with "(staging only)" at the end for ' +
            'an active probe. Default output is plan-lines.json beside the input.',
    },
    {
        name: 'release-list',
        usage: 'qar release-list',
        summary: 'List management-app release tags, newest first.',
    },
    {
        name: 'release-prs',
        usage: 'qar release-prs --tag <tag>',
        summary:
            'Write the PR set of a release (from the tag compare) to .tmp/release/<tag>/prs.json.',
        details:
            'The set comes from compare/<previous>...<tag>, never from the release body alone: ' +
            'the body is generated and has missed a third of a release. notesMissing lists ' +
            'PRs the body omits. Each PR carries its Jira keys, files, and body.',
    },
    {
        name: 'results-render',
        usage: 'qar results-render --tag <tag> --env <env> --plan <plan-lines.json> --results <results.json>',
        summary: "Render a release run's results as the markdown asset, with secrets redacted.",
        details:
            'Writes regression-results-<env>-<stamp>.md under .tmp/release/<tag>/ and prints {"output","asset"}.',
    },
    {
        name: 'release-status',
        usage: 'qar release-status --tag <tag>',
        summary: 'Report the assets on a release, upload rights, and the local plan/results files.',
    },
    {
        name: 'release-download',
        usage: 'qar release-download --tag <tag> [--asset regression-plan.md]',
        summary: 'Download one release asset into .tmp/release/<tag>/ (the plan lands as plan.md).',
    },
    {
        name: 'release-upload',
        usage: 'qar release-upload --tag <tag> --file <path> [--as <asset name>]',
        summary:
            'Upload a file under .tmp/release/<tag>/ as a release asset (only regression-plan.md is replaced; other assets are never overwritten).',
        details: 'Refuses any file outside the release dir. Prints {"tag","asset","url"}.',
    },
    {
        name: 'release-saved',
        usage: 'qar release-saved --tag <tag> --asset <name> [--url <url>]',
        summary: 'Tell the GUI a release asset was uploaded (clears the unsaved badge).',
    },
    {
        name: 'release-summary',
        usage: 'qar release-summary --tag <tag> [--input <plan.md>]',
        summary:
            "Write the plan's Summary section into the release description, above the PR table.",
        details:
            'Inserts a <!-- regression-summary --> block before the "------" separator (or replaces the existing block). Nothing else in the description changes.',
    },
    {
        name: 'clock',
        usage: 'qar clock --file <path.json> (--mark <phase> | --report)',
        summary: 'Record validation phase times and print the durations for the report.',
        details:
            '--mark appends a timestamp named by the phase it ends (start, inventory, approved, ' +
            'tested, posted). --report prints "Total 1 h 12 min · inventory 14 min · …".',
    },
] as const satisfies readonly CommandHelp[]

export function commandNames(): string[] {
    return COMMANDS.map(c => c.name)
}

// `qar --help` — the command list. Kept short: per-command detail lives behind
// `qar <command> --help`.
export function topLevelHelp(): string {
    const width = Math.max(...COMMANDS.map(c => c.name.length))
    const lines = COMMANDS.map(c => `  ${c.name.padEnd(width)}  ${c.summary}`)
    return [
        'qar — the SafeInsights QA runner CLI.',
        '',
        'Usage: qar <command> [options]',
        '',
        'Commands:',
        ...lines,
        '',
        'Run `qar <command> --help` for the options of a single command.',
    ].join('\n')
}

// `qar <command> --help` — usage line plus any caveats worth knowing before running.
export function commandHelp(name: string): string | null {
    // Widened back to CommandHelp: `as const` on COMMANDS keeps the names as literals
    // (which is what CommandName needs), but it also drops `details` from the entries
    // that omit it, so the union has no such property to read below.
    const command: CommandHelp | undefined = COMMANDS.find(c => c.name === name)
    if (!command) return null
    const parts = [command.summary, '', `Usage: ${command.usage}`]
    if (command.details) parts.push('', command.details)
    return parts.join('\n')
}

export function unknownCommandMessage(subcommand: string | undefined): string {
    return (
        `Unknown command "${subcommand ?? ''}".\n\n` +
        `Commands: ${commandNames().join(' | ')}\n` +
        `Run \`qar --help\` for details.`
    )
}
