interface CommandHelp {
    name: string
    usage: string
    summary: string
    details?: string
}

// One entry per subcommand in bin/qar.ts. Keep this list in sync with the switch
// there — `qar --help` is the discovery path for anyone who doesn't know the flags.
export const COMMANDS: CommandHelp[] = [
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
        usage: 'qar set-secret --key <VAR> --value <value>',
        summary: 'Encrypt one secret to every keyring recipient.',
    },
    {
        name: 'get-secret',
        usage: 'qar get-secret --name <VAR> [--force]',
        summary: 'Print one decrypted secret to stdout (the read half of set-secret).',
        details:
            "The var is named with --name, not --key: --key is fix-account's valueless\n" +
            'boolean switch and the parser shares one booleans list across subcommands.\n\n' +
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
        name: 'session-create-user',
        usage: 'qar session-create-user --role <researcher|reviewer>',
        summary: 'Invite + complete signup for a fresh user. Prints {"userId","email"}.',
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
        usage: 'qar jira-comment --issue <KEY> --body-file <path.md> [--images a.png,b.png]',
        summary: 'Post ONE Jira comment with screenshots embedded inline.',
        details:
            'Body is Markdown (headings, bold, lists, links). Use {{image:N}} to place an image inline.',
    },
    {
        name: 'jira-delete-comment',
        usage: 'qar jira-delete-comment --issue <KEY> --ids <id1,id2>',
        summary: 'Delete Jira comments (404 = already gone = success).',
    },
    {
        name: 'verdict-posted',
        usage: 'qar verdict-posted --issue <KEY> --result <validated|rejected>',
        summary: 'Tell the GUI a verdict was posted, so it hides the Verdict button.',
        details: 'Call right after posting a verdict comment + transition to Jira.',
    },
]

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
    const command = COMMANDS.find(c => c.name === name)
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
