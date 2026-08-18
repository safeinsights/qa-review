package main

import "testing"

// These are the exact strings observed in diagnostics.log from real failed syncs.
// Each is a config/environment problem, NOT a divergence — so "Reset to clean &
// sync" cannot fix any of them, and reporting them as diverged produces a banner
// whose button reruns the same failure forever.
func TestIsGitConfigFailure(t *testing.T) {
	configFailures := []string{
		"fatal: Cannot rebase onto multiple branches.",
		"Your configuration specifies to merge with the ref 'refs/heads/fix/empty-access-branch'\nfrom the remote, but no such ref was fetched.",
		"There is no tracking information for the current branch.",
		"fatal: couldn't find remote ref refs/heads/gone",
	}
	for _, out := range configFailures {
		if !isGitConfigFailure(out) {
			t.Errorf("expected config failure for %q", out)
		}
	}

	// A genuine non-fast-forward IS recoverable by resetting, so it must keep
	// reporting as diverged and keep offering the Reset button.
	diverged := []string{
		"fatal: Not possible to fast-forward, aborting.",
		"error: Your local changes to the following files would be overwritten",
	}
	for _, out := range diverged {
		if isGitConfigFailure(out) {
			t.Errorf("expected divergence (not config failure) for %q", out)
		}
	}
}
