# Syncing updates

The suites, settings, and the keyring all live in the project files the app
downloaded on first launch. When a teammate adds a new suite, updates a password,
or approves someone's access, you get those changes by **syncing**.

## The Sync button

The **Sync** button at the top of the window pulls the latest project files. It's
safe to press any time — do it when:

- A new suite should exist but you don't see it.
- You just requested (or were approved for) keyring access.
- You see a "rekey needed" / out-of-sync banner.

Sync only moves forward — it won't overwrite work or force anything. If your
copy has uncommitted edits or has diverged, Sync **skips** rather than risk your
changes, and tells you so.

## Reset to clean & sync

If Sync keeps skipping because of local edits you don't care about, use **Reset
to clean & sync**. This throws away *uncommitted* edits to the project files and
then syncs. It keeps any saved commits — it only discards unsaved changes — so
it's the way to get unstuck when your copy is in a messy state.

If you're not sure whether you have edits worth keeping, ask a teammate before
using Reset.
