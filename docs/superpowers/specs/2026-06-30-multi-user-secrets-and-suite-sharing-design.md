# Multi-user secrets & suite sharing — design

**Date:** 2026-06-30
**Status:** Approved (ready for implementation plan)

## Goal

Make sharing settings and suites among QA staff as frictionless as git allows:

1. **Multi-user encryption** — replace the single shared scrypt passphrase with
   per-user age X25519 keys, so access is revocable per person and no shared
   secret circulates out-of-band.
2. **Self-service onboarding** — a new QA staffer clicks "Request access", which
   generates their key locally and opens a PR adding their public key to a
   committed keyring. GitHub merge permissions are the trust boundary.
3. **Automatic distribution** — on startup the app fast-forward-pulls the repo,
   so suites, the keyring, and the re-encrypted secrets all stay current through
   one mechanism.

## Foundational decisions

- **The private repo is the single source of truth**, PR-gated. A `git pull`
  distributes suites, the keyring, and the re-encrypted secrets together.
- **Trust is GitHub-enforced, never app-enforced.** The app only opens PRs;
  GitHub branch protection / merge permissions (optionally CODEOWNERS on
  `config/keyring.json`) decide who may add a recipient. The app contains no
  access-control logic of its own.
- **CI runs keyless.** No age identity in CI. Runtime secrets come from
  env-var Actions secrets, which already override every file tier in
  `loadSettings()`.
- **No migration.** `settings.secrets.json` is effectively empty today (`{}`),
  so there is no legacy scrypt data to preserve. The first maintainer sets up
  an identity and re-enters secrets as the new baseline.

---

## Section 1 — Multi-recipient encryption model

Replace scrypt/passphrase age encryption with **age X25519 recipients**.

- **Keyring** — a new committed file `config/keyring.json`: an array of entries,
  each `{ name, publicKey, email, addedDate }`. `publicKey` is an `age1…`
  recipient; `email` comes from `git config user.email` at request time;
  `addedDate` is an ISO date. This is the canonical "who can decrypt" list.
- **Secrets** — `settings.secrets.json` keeps its current shape (key → armored
  age blob), but each value is encrypted **to all recipients in the keyring**
  rather than to a passphrase. Any single recipient's private key decrypts it.
- **Per-secret blobs** — editing one secret re-encrypts only that value
  (granular git diffs).
- **The passphrase path is removed entirely** — no hybrid fallback. `AGE_PASSPHRASE`,
  `PASSPHRASE_VAR`, `decryptValue(passphrase)`, `encryptValue(passphrase)`,
  `NewScryptRecipient`, and the GUI's `SetPassphrase`/session-passphrase state all go.

Both sides switch crypto primitives:
- **Go** (`gui/settings.go`, `filippo.io/age`): X25519 recipients/identities
  instead of `age.NewScryptRecipient`.
- **TS** (`src/engine/settings.ts`, `age-encryption`): X25519 identities instead
  of `setPassphrase`/`addPassphrase`.
- `tests/engine/age-interop.test.ts` is extended to cover X25519 round-trips
  (Go-encrypted → TS-decrypted and vice versa).

## Section 2 — Local identity & key storage

- **Keypair generated locally** on request-access (Go `age.GenerateX25519Identity`
  in the GUI; equivalent in the CLI). The private key **never leaves the machine**.
- **Private key** → `config/age-identity.txt`, standard age identity format
  (`AGE-SECRET-KEY-1…` with a `# public key: age1…` comment). **Gitignored**
  (added alongside `settings.local.json`). Not the OS keychain in v1 (YAGNI;
  a gitignored file is simpler and cross-platform).
- **Public key** is derived from the identity and written into `config/keyring.json`.
- **`loadSettings()` decrypts with the local identity** at
  `config/age-identity.txt` (path overridable via `AGE_IDENTITY_FILE` for
  flexibility). **If no identity is present, it skips encrypted values** (leaves
  those keys unset) instead of throwing — other tiers / `process.env` may supply
  them. A genuinely missing required secret still surfaces later via the existing
  `env.ts read()` → `Missing required secret: <VAR>` path.
- **No identity present** = "not yet onboarded" → the GUI surfaces **Request
  access** (Section 4) instead of attempting to decrypt.
- **CI** sets `RESEARCHER_PASSWORD`, `RESEARCHER_MFA_CODE`, … as env-var Actions
  secrets. With no identity, the encrypted file is skipped and env vars supply
  the values. No age key, no keyring entry, no decryption in CI.

## Section 3 — Rekey operations

Two CLI commands (GUI buttons shell out to them); both require the caller to
already hold a valid identity that can decrypt.

- **`otto rekey`** — re-encrypts **all** secrets in `settings.secrets.json` to the
  **current** `config/keyring.json` recipient set. Flow: read identity → decrypt
  each secret → re-encrypt each to all current recipients → write file. Used by the
  reviewer when adding a recipient, and after a revocation.
- **`otto set-secret <VAR>`** — the edit path (also called by the GUI Settings
  "save secret" action). Encrypts the **one** new plaintext value to all current
  recipients and writes that single key. Replaces the Go `encryptString`-to-passphrase
  path in `WriteSetting`.

**Keyring-drift detection (safety net).** age ciphertext doesn't expose its
recipients, so a committed **`config/keyring.lock`** stores a fingerprint (hash)
of the recipient set the secrets were last encrypted to. On startup (after the
Section 5 pull) the app compares `keyring.json`'s fingerprint to `keyring.lock`:
- mismatch → **"secrets are out of sync with the keyring — rekey needed"** banner.
- A user who can decrypt clicks **Rekey** → runs `otto rekey`, updates
  `keyring.lock`, pushes.
- A user who can't yet decrypt (key added but not yet rekeyed) sees "waiting for a
  teammate to rekey".

**Reviewer rekey is atomic with the access PR.** The reviewer checks out the
access-PR branch, runs `otto rekey` (re-encrypting to the keyring that now
includes the new key), pushes onto that same branch, then merges. The new user can
decrypt the instant the PR merges — no drift window. The GUI can offer this as a
one-button "Approve & rekey" reviewer action. The drift banner remains the safety
net for any out-of-band edits.

## Section 4 — Request-access onboarding

A **"Request access"** button in the GUI (shown whenever `config/age-identity.txt`
is absent), backed by `otto request-access --name "Jane Smith"`. The command:

1. **Generates** an age X25519 keypair locally; writes the private key to the
   gitignored `config/age-identity.txt`.
2. **Adds** `{ name, publicKey, email, addedDate }` to `config/keyring.json`
   (email from `git config user.email`).
3. **Branches** (e.g. `access/jane-smith`) and commits the keyring change only —
   a small, easily reviewed diff.
4. **Opens a PR** via the `gh` CLI ("Add Jane Smith to keyring"), with a body
   telling the reviewer to use "Approve & rekey" before merging.

Then the user **waits**: they have an identity but can't decrypt until a reviewer
rekeys and the PR merges; after they pull (Section 5), drift resolves and
decryption works.

Edge cases:
- **`gh` missing / not authed** → fall back to printing the branch name, the exact
  public-key line to add, and a manual-PR link.
- **Identity already exists but user not in keyring** (e.g. re-clone) → re-submit
  the *existing* public key rather than generating a new one.
- **Name collision** in the keyring → require a unique name/handle.

## Section 5 — Startup sync (suites + settings)

On launch (and via an explicit **Sync** button / `otto sync`), run a
**fast-forward-only `git pull`** of the repo.

- **Clean + fast-forwardable** → pull succeeds, optional "synced — N suites
  updated" note. New suites are the new `.ts` files on disk; the existing
  `suite-registry.ts` glob discovers them with no extra wiring.
- **Not clean / would not fast-forward** → **skip the pull**, show a non-blocking
  banner ("Couldn't sync — you have local changes" / "diverged from main").
  Never touches the user's work.
  - The banner offers **"Reset to clean & sync"**: discard only **uncommitted
    tracked edits** (`git restore` / `git checkout -- .`), **preserve local
    commits**, then retry the fast-forward pull. Gitignored files
    (`config/age-identity.txt`, `settings.local.json`) are untouched. If local
    commits still diverge, the pull legitimately can't fast-forward and the banner
    reappears with "you have unpushed local commits — push or open a PR". We never
    discard committed work the user may not have meant to lose.
- **After a successful pull** → run the Section 3 keyring-drift check.

Implementation: a GUI `Sync()` Go method (runs `git` in the repo dir, parses
status/result) + React banner/actions; a `otto sync` CLI mirror for headless use.
Git/network failures are non-fatal — the app runs with whatever is on disk.

---

## Revocation (documented manual process)

No dedicated command or UI. To revoke: remove the entry from
`config/keyring.json` and run `otto rekey`, landed via a normal PR. The underlying
operation is identical to `rekey` after any keyring change. **Note:** a revoked
user can still read OLD secrets they already pulled; rotate those secrets (change
the actual passwords / MFA seeds and `set-secret` them) if they are truly
sensitive.

## Out of scope (YAGNI)

- OS-keychain storage of the private key (gitignored file is enough for v1).
- Migration from scrypt-encrypted secrets (no legacy data exists).
- A dedicated revoke command/UI (manual process suffices).
- A CI age identity (CI is keyless by design).
- Separate suite registry/package (suites ride the repo).

## Files touched (anticipated)

- `config/keyring.json` (new, committed), `config/keyring.lock` (new, committed).
- `config/age-identity.txt` (new, gitignored); `.gitignore` updated.
- `src/engine/settings.ts` — X25519 load/decrypt, identity file, skip-when-absent,
  remove passphrase path.
- `gui/settings.go` — X25519 encrypt, `set-secret`, remove `SetPassphrase`/session
  passphrase; new `Sync()`, request-access/rekey wiring (or shelling to CLI).
- `bin/otto.ts` — new subcommands: `request-access`, `rekey`, `set-secret`, `sync`.
- `tests/engine/age-interop.test.ts` — X25519 interop coverage.
- GUI React — Request-access button, drift/rekey banner, sync banner + "Reset to
  clean & sync", "Approve & rekey" reviewer action.
- `CLAUDE.md` — update the Settings/configuration section to the new model.
