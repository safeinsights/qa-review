package main

import "testing"

// Only a genuine non-fast-forward is divergence: it is the one case "Reset to
// clean & sync" resolves. Every other pull failure must report as failed with
// git's own text, or the banner offers a Reset that reruns the same failure.
func TestIsGitNonFastForward(t *testing.T) {
	if !isGitNonFastForward("fatal: Not possible to fast-forward, aborting.") {
		t.Errorf("expected a non-fast-forward to read as divergence")
	}

	// Exact strings observed in diagnostics.log from real failed syncs, plus one
	// the classifier has never seen. None is fixed by a reset.
	notDiverged := []string{
		"fatal: Cannot rebase onto multiple branches.",
		"fatal: Cannot fast-forward to multiple branches.",
		"Your configuration specifies to merge with the ref 'refs/heads/fix/empty-access-branch'\nfrom the remote, but no such ref was fetched.",
		"There is no tracking information for the current branch.",
		"fatal: couldn't find remote ref refs/heads/gone",
		"error: unable to unlink old '.claude/skills/qa-validate/SKILL.md': Operation not permitted",
		"error: unable to create file .claude/hooks/pre.sh: Permission denied",
		"git@github.com: Permission denied (publickey).",
		"error: Your local changes to the following files would be overwritten",
		"fatal: some message git has not printed before",
	}
	for _, out := range notDiverged {
		if isGitNonFastForward(out) {
			t.Errorf("expected failure (not divergence) for %q", out)
		}
	}
}
