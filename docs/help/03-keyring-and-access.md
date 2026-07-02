# Keyring & access

The suites sign in as real shared test accounts. Those passwords (and the
one-time login codes) are **encrypted** inside the project so only approved
teammates can read them. The list of who's approved is called the **keyring**.

You don't need to understand the cryptography — just these few situations.

## Requesting access

If you're new, the app can't decrypt the shared secrets yet, so runs would fail
with a "missing password" error. To fix that:

1. Press **Request access** (the app offers this on first launch, and it's also
   in Settings).
2. This creates your personal key and opens a request for a teammate to approve.
3. A teammate approves it (they merge your request and re-encrypt the secrets to
   include you). After that, **Sync** and you're set.

Until you're approved, you can still run suites if someone gives you the
passwords another way, but requesting access is the normal path.

## The "rekey needed" / drift banner

Sometimes you'll see a banner saying the keyring is **out of sync** or that a
**rekey** is needed. This means the list of approved people changed but the
secrets haven't been re-encrypted to match yet.

- If you see it, **Sync** first — often that resolves it.
- If it persists, it's a maintenance step a teammate performs (a "rekey"). Let
  the team know; it's not something you broke.

## Who approves access

Approvals happen through the project's GitHub — a teammate with permission
reviews and merges the request. Trust is managed there, not inside this app.

## If someone leaves

Removing someone's access is a manual step a maintainer does (remove them from
the keyring, re-encrypt, and rotate the actual passwords if needed). Again, not
something you need to handle from this screen.
