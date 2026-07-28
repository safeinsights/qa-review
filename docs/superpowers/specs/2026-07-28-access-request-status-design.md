# Access request status — design

Date: 2026-07-28

## Problem

Requesting keyring access is a fire-once action with no memory of having been
fired. Every failure mode follows from that.

A repeat "Request access" click runs `requestAccess()` again, which calls
`addMember()` — and that throws `"<name>" is already in the keyring (names must
be unique)`, because the FIRST click already wrote the entry into the local
working-tree `config/keyring.json`. The user cannot retry under their own name.
The only escape the UI offers is the name input, so they rename. A new name
produces a new branch slug, so `git checkout -b access/<slug>` (which would also
have failed — the branch already exists locally) now succeeds, and a SECOND
branch and PR are pushed for the same key.

Meanwhile `gh pr create` on a repeat fails with "a pull request for branch X
already exists", which lands in the `catch` that prints `Could not open a PR
automatically:`. The user reads that as failure and tries again. The one message
that would end the loop — "your PR #21 is open, waiting on a reviewer" — is
something the current code structurally cannot produce, because it never queries
PR state.

`git log config/keyring.json` preserves the loop: Greg Fitch has PR #21
(`access/gf`), #28 (revoke), and #29 (`access/greg-fitch`).

Two further hazards compound it:

- **The local keyring entry is not durable.** `CheckKeyringAccess` calls
  `syncKeyringFiles`, which runs `git checkout <upstream> -- config/keyring.json`
  and discards the local entry. So whether a same-name retry throws depends on
  whether a fetch succeeded in between — non-deterministic from the user's seat.
- **Merging the access PR is not sufficient.** `identityDecryptsSecrets` requires
  EVERY encrypted secret to decrypt, which only holds after a reviewer also runs
  `qar rekey`. Between merge and rekey, "Retry — I have access" keeps saying no
  with no indication that a second human step is outstanding.

## Approach

The button stops being an action and becomes a **status display**.

The durable anchor is the local age keypair in `config/age-identity.txt`: it is
gitignored, never overwritten by `createIdentity`, and unaffected by
`syncKeyringFiles`. Every question — "did I request?", "which branch?", "is the
PR open?", "did it merge?" — is keyed off that public key rather than off a name
the user types.

Deduplication is on the **public key**, not the name. A renamed request maps to
the same identity and therefore the same branch.

Rejected alternative: a separate gitignored sentinel file
(`config/access-request.json`). It duplicates state the identity file already
anchors, adds a second file that can desynchronize from the keypair it describes,
and needs its own gitignore entry. Storing the metadata as comments in the
identity file keeps one file, atomically tied to the key.

## Components

### 1. Identity file carries the request record

`createIdentity` already writes a `# public key:` comment. Extend the header:

```
# public key: age1ddz...
# name: Greg Fitch
# branch: access/greg-fitch
AGE-SECRET-KEY-1...
```

`readIdentity` skips `#` lines already, so the secret-key path is unchanged. A
new `readIdentityMeta(dir)` returns `{publicKey, name, branch}` parsed from the
comments.

**Backward compatibility:** identity files written before this change have no
`# name:` / `# branch:` lines. `readIdentityMeta` returns `undefined` for those
fields and callers fall back to deriving the slug from `git config user.name`.
Existing installs keep working.

### 2. Name is derived, not asked

The name comes from `git config user.name`, mirroring the existing
`safeGitConfigEmail()` — the repo already trusts `git config user.email` for the
more consequential keyring field. The GUI drops the name input. Only when git has
no name configured does the UI prompt for one.

The CLI keeps `--name` as an explicit override (it is how the "Nathan Stitt
(dev)" second identity was created).

### 3. `qar access-status --json` — single source of truth

A new engine subcommand consumed by both the CLI and the Go GUI. It resolves, in
order:

1. local identity present?
2. is the public key in the upstream `config/keyring.json`?
3. do all encrypted secrets decrypt?
4. does the branch exist on the remote (`git ls-remote --heads origin <branch>`)?
5. PR state (`gh pr list --head <branch> --state all --json number,state,url`)

Output:

```json
{
  "state": "pr-open",
  "publicKey": "age1ddz...",
  "name": "Greg Fitch",
  "branch": "access/greg-fitch",
  "pr": { "number": 21, "state": "OPEN", "url": "https://..." },
  "githubReachable": true,
  "note": ""
}
```

`state` is exactly one of:

| state | meaning |
| --- | --- |
| `no-identity` | no `age-identity.txt` — nothing requested |
| `no-branch` | identity exists, branch not on the remote |
| `branch-no-pr` | branch pushed, no PR found |
| `pr-open` | PR open, awaiting review |
| `pr-closed` | PR closed without merging |
| `merged-awaiting-rekey` | key is in the upstream keyring, secrets do not all decrypt |
| `ready` | key in keyring and all secrets decrypt |

Uses the same injectable-runner pattern as `requestAccess`'s `GitRunner`, so
every state is unit-testable without a live GitHub.

**Degradation is one-directional.** Any `gh`/network failure sets
`githubReachable: false`, populates `note`, and falls back to the best LOCAL
answer. It must never report `no-identity` when an identity exists — downgrading
an existing request to "no request" is precisely what restarts the duplicate
loop. `Preflight()` already gates on `gh` being installed, but `gh` can be
installed yet unauthenticated, which this path must survive.

### 4. Idempotent actions

- **`addMember`** — a re-add whose name AND publicKey both match an existing
  entry is a no-op returning the unchanged array. A DIFFERENT key under a taken
  name is still rejected. This removes the pressure to rename.
- **Branch creation** — `checkout -b` only when the branch does not exist;
  otherwise check out and reuse. Same key, same branch, always.
- **`gh pr create`** — on "already exists", query the existing PR and report it
  as SUCCESS with its URL, not as a failure.

`requestAccess` splits into two separately callable pieces:

- `requestAccess()` — create identity, write metadata, add to keyring, push branch
- `openAccessPr()` — create-or-report the PR for an existing branch

so the `branch-no-pr` state has something to retry. This state is reachable today
whenever the push succeeds and `gh pr create` does not: the branch lands on the
remote, the PR does not, and nothing ever re-drives it. New CLI subcommand `qar
open-access-pr` exposes it.

### 5. UI

`KeyringAccessGate`'s modal renders per state, with one primary button whose
label and action follow the state:

| state | message | button |
| --- | --- | --- |
| `no-identity` | "Request access to decrypt shared secrets" | **Request access** |
| `no-branch` | "Identity created, not yet submitted" | **Submit request** |
| `branch-no-pr` | "Branch pushed, no pull request yet" | **Open pull request** |
| `pr-open` | "PR #21 open — awaiting a reviewer" + link | **Check again** |
| `pr-closed` | "PR #21 was closed without merging" | **Re-open request** |
| `merged-awaiting-rekey` | "Merged — a reviewer must run `qar rekey`" | **Check again** |
| GitHub unreachable | last known local state + "couldn't reach GitHub" | action stays enabled |

PR creation stays an EXPLICIT button rather than firing automatically on launch.
Auto-creating would fight the `pr-closed` state — resurrecting a PR a reviewer
deliberately closed — and it is an outward-facing write that should follow a
click.

`merged-awaiting-rekey` earns its own row independently of the duplicate-request
fix: today that state shows a bare "Retry — I have access" that keeps saying no,
with nothing explaining that a second human step is outstanding.

`RequestAccessButton` (Settings tab) collapses to the same status component, so
there is one rendering of access state in the app.

### 6. Go wiring

`CheckKeyringAccess` shells `qar access-status --json` via `engineCmd` and folds
the result into `KeyringAccess` (adding `state`, `branch`, `pr`,
`githubReachable`). A failed or malformed engine call surfaces as a `note`, not
an error — consistent with the existing non-fatal `syncKeyringFiles` note.

Keeping the logic in the engine rather than Go means the CLI path
(`pnpm qar request-access`), which has the identical duplicate-request problem,
is fixed by the same change, and keeps `gh`-shaped logic in one language.

## Testing

vitest:

- one case per `access-status` state, with a stubbed runner
- GitHub-unreachable degradation asserts the state never becomes `no-identity`
  when an identity exists
- `addMember`: same-name-same-key re-add is a no-op; same-name-different-key is
  still rejected
- identity metadata round-trip, plus the legacy no-metadata fallback
- `openAccessPr` treats "already exists" as success and returns the existing URL

Go (`gui/settings_test.go`, `gui/app_test.go`):

- `CheckKeyringAccess` folds engine JSON into `KeyringAccess`
- a failed/malformed engine call yields a note, not an error

## Out of scope

- Revocation flow (still manual: edit `keyring.json`, `qar rekey`, PR).
- Notifying the reviewer that a request is waiting.
- Auto-rekey on merge — the reviewer step stays deliberate.
