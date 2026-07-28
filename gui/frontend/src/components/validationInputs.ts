// Parsing for the Validation screen's two identifier inputs. Both accept a pasted
// URL, and the PARSED value is what reaches the engine (`--pr`), the PR preview
// base URL, and `gh pr view` — so reducing a URL here is behavior, not cosmetics.
//
// Kept in a plain .ts module (not ValidationTab.tsx) so the engine's tsconfig —
// which has no JSX/DOM lib — can typecheck the tests that cover it.

// Accept either a bare Jira key (OTTER-123) or a full URL
// (e.g. https://openstax.atlassian.net/browse/OTTER-123?focused=…) and return the key.
export function parseJiraCard(input: string): string {
    const m = input.match(/[A-Z][A-Z0-9]+-\d+/i)
    return m ? m[0].toUpperCase() : input.trim()
}

// Accept a bare PR number, a "#839", or a GitHub PR URL
// (https://github.com/safeinsights/management-app/pull/839/files#discussion_r1) and
// return just the number.
export function parsePrNumber(input: string): string {
    const trimmed = input.trim()
    // Prefer the /pull/<n> segment: a URL's trailing fragment or query can also
    // contain digits, and a bare first-number match would pick the wrong one.
    const fromUrl = trimmed.match(/\/pull\/(\d+)/)
    if (fromUrl) return fromUrl[1]
    const bare = trimmed.match(/^#?(\d+)$/)
    return bare ? bare[1] : trimmed
}

// Whether the PR input resolved to a real PR number. A PR overrides the env — the
// preview URL is derived from the number — so the Env selector is disabled on the
// strength of THIS, not on the box merely being non-empty: parsePrNumber passes
// unrecognized text through unchanged, and locking Env on a typo would strand the
// user with no usable target and no way back to picking an env.
export function isPrNumber(input: string): boolean {
    return /^\d+$/.test(parsePrNumber(input))
}
