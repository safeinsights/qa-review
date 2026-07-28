# Dependencies & setup

Everything the QA Runner needs, and how to install it.

**Which half do you need?**

- **Just running tests?** Install the [desktop app](#a-running-the-desktop-app), then
  the four tools in [Required tools](#required-tools). No terminal work beyond that.
- **Working on the code?** Also do [Building from source](#b-building-from-source).

macOS only today — the desktop app is a signed `.app`, and tool paths below assume
Homebrew. If you don't have Homebrew, install it first from
[brew.sh](https://brew.sh).

---

## Required tools

The packaged app deliberately does **not** bundle these; it uses the ones on your
machine. Its **Settings ▸ Setup Doctor** checks every row in this table and tells you
which are missing, so run that first rather than auditing by hand.

| Tool | Why it's needed | Install |
|---|---|---|
| **Google Chrome** | Playwright drives *your* Chrome (`channel: 'chrome'`) — no separate browser is downloaded | [google.com/chrome](https://www.google.com/chrome/) |
| **git** | Clones and syncs the test repo | `xcode-select --install` or `brew install git` |
| **GitHub CLI (`gh`)** | Clones the repo, opens keyring access PRs, reads PRs during validation | `brew install gh` |
| **Claude Code (`claude`)** | Powers suite authoring, the run companion, and ticket validation | [Claude Code setup](https://docs.anthropic.com/en/docs/claude-code/setup) |
| **Node.js (`node`)** | Runs the test engine | `brew install node` |
| **uv (`uvx`)** | Runs the Jira MCP server for validation | `brew install uv` |

One-liner for the Homebrew-installable ones:

```bash
brew install git gh node uv
```

Chrome and Claude Code are separate installs — see their links above.

### Authenticate `gh`

Installing `gh` isn't enough; it must be logged in, or cloning and every PR flow
fails:

```bash
gh auth login
```

Choose **GitHub.com** → **HTTPS** → **login with a web browser**. Verify with
`gh auth status`.

### Versions

These are what the project is developed against. Anything reasonably current works —
the Setup Doctor reports the version it finds, and only flags a tool as broken if it
can't run at all.

| | Known-good |
|---|---|
| Node.js | 25.x (18+ works) |
| git | 2.51 |
| gh | 2.96 |
| Claude Code | 2.1.x |
| uv | 0.10 |

---

## A. Running the desktop app

1. Install the [required tools](#required-tools) above.
2. Get the `.dmg` from a teammate (or build it — see below), drag the app to
   `/Applications`, and open it.
3. **First launch** asks where to keep its files, then clones the test repo there.
4. Press **Request access** so a teammate can grant you the shared secrets — see
   [Keyring & access](help/03-keyring-and-access.md). Until that's approved, suites
   can't sign in.
5. Open **Settings ▸ Setup Doctor** and confirm every row is green.

That's it. You don't need Node, pnpm, or a checkout — the app ships its own engine
runtime.

---

## B. Building from source

Additionally required for development:

| Tool | Why | Install |
|---|---|---|
| **pnpm** | Package manager (the lockfile is pnpm's) | `brew install pnpm` or `corepack enable` |
| **Go** | The GUI backend is Wails (Go + React) | `brew install go` |
| **Wails CLI** | Dev server and app packaging | `go install github.com/wailsapp/wails/v2/cmd/wails@latest` |

Go 1.24+ is required (`gui/go.mod`); 1.26 is known-good. After `go install`, make sure
`~/go/bin` is on your `PATH` or the `wails` command won't resolve.

```bash
pnpm install                  # JS deps (Playwright, age-encryption, …)
pnpm qar list                 # smoke test: lists the suites
cd gui && wails dev           # run the GUI in dev mode
```

Checks, all of which CI runs:

```bash
pnpm test          # vitest
pnpm typecheck     # tsc --noEmit
pnpm lint          # biome check — the CI gate (pnpm lint:fix to auto-fix)
cd gui && go test ./...
```

Building the standalone app:

```bash
make engine         # bundle just the engine (esbuild)
make dmg-unsigned   # full pipeline minus signing — local smoke test
make dmg            # signed + notarized (needs DEVELOPER_ID + NOTARY_PROFILE)
```

Playwright browsers are **not** downloaded — the engine launches your installed
Chrome, so there's no `playwright install` step.

---

## Jira API token

Only needed for **ticket validation**, which reads a Jira card and posts the verdict
plus screenshots back to it. Skip this if you only run suites.

### 1. Create the token

1. Go to
   [id.atlassian.com/manage-profile/security/api-tokens](https://id.atlassian.com/manage-profile/security/api-tokens).
2. **Create API token**.
3. Name it something you'll recognise later (e.g. `qa-runner`), set an expiry, and
   **Create**.
4. **Copy it now** — Atlassian shows the token exactly once. If you lose it, revoke it
   and create another; there's no way to view it again.

A token acts as your Atlassian account. Anything posted with it is attributed to you.

### 2. Save it in the app

**Settings ▸ Jira**, which needs three values:

| Field | Value |
|---|---|
| **Jira site URL** | `https://openstax.atlassian.net` |
| **Jira email** | The Atlassian account email the token belongs to |
| **Jira API token** | The token you just copied |

These are stored **local-only** — written to `config/settings.local.json`, which is
gitignored and never encrypted or committed, because the token is personal rather than
shared. That's enforced server-side too: the app refuses to save these three to the
project tier.

Note the email must match the account that created the token. A mismatched pair
authenticates as nobody and every Jira call 401s.

### 3. Verify

```bash
qar jira-comment --issue OTTER-640 --body-file /tmp/test.md
```

It prints `{"id","url"}` on success. Remove the test comment with:

```bash
qar jira-delete-comment --issue OTTER-640 --ids <id>
```

### From a terminal instead

`qar` reads the same layered settings, so once saved in the app the CLI just works.
Without the GUI, either put the three values in `config/settings.local.json` or pass
them as environment variables, which override the files:

```bash
JIRA_URL=https://openstax.atlassian.net \
JIRA_USERNAME=you@rice.edu \
JIRA_API_TOKEN=<token> \
  qar jira-comment --issue OTTER-640 --body-file notes.md
```

---

## Shared test-account secrets

Suites sign in as real test accounts whose passwords and MFA seeds are **encrypted in
the repo**, one copy per teammate (age X25519) — there is no shared passphrase.

```bash
qar request-access --name "Your Name"     # or Settings ▸ Request access
```

That generates your key, adds it to `config/keyring.json`, and opens a PR. A teammate
runs `qar rekey` on your branch and merges it. Until then the Setup Doctor's
**Encryption identity** row stays red and suites fail with
`Missing required secret: …`.

CI needs no key: with no identity file, encrypted values are skipped and the
`*_PASSWORD` / `*_MFA_*` variables come from the environment instead.

Full detail in [Keyring & access](help/03-keyring-and-access.md).

---

## Troubleshooting

**Setup Doctor says a tool isn't on PATH, but it works in my terminal.**
An app launched from Finder doesn't inherit your shell's `PATH`. The app prepends the
usual Homebrew locations, but a tool installed somewhere unusual won't be found —
symlink it into `/opt/homebrew/bin` or `/usr/local/bin`.

**`wails dev` fails with `operation not permitted`.**
It runs `go mod tidy`, which writes to `~/Library/Caches/go-build`. Run it with the
sandbox disabled.

**Jira calls return 401.**
Almost always the email/token pair. Confirm the email is the account that created the
token, and that the token hasn't expired or been revoked.

**A run does nothing and no steps appear.**
The GUI ignores non-JSON engine output, so an early crash is silent. Run the same
thing on the CLI to see the real error:

```bash
qar run --suite <suite> --role <role> --env qa
```

More in [Troubleshooting](help/05-troubleshooting.md).
