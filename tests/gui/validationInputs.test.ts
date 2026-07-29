import { describe, expect, it } from 'vitest'
import {
    ciBlocks,
    isPrNumber,
    parseJiraCard,
    parsePrNumber,
} from '@/gui/components/validationInputs'

// Both validation inputs accept a pasted URL. The parsed value is what reaches the
// engine (`--pr`), the PR preview base URL, and `gh pr view` — so a URL that isn't
// reduced to a bare number breaks the session, not just the display.
describe('parsePrNumber', () => {
    it('passes through a bare number', () => {
        expect(parsePrNumber('839')).toBe('839')
    })

    it('trims surrounding whitespace', () => {
        expect(parsePrNumber('  839  ')).toBe('839')
    })

    it('strips a leading #', () => {
        expect(parsePrNumber('#839')).toBe('839')
    })

    it('pulls the number out of a GitHub PR URL', () => {
        expect(parsePrNumber('https://github.com/safeinsights/management-app/pull/839')).toBe('839')
    })

    it('handles a /files sub-path', () => {
        expect(parsePrNumber('https://github.com/safeinsights/management-app/pull/839/files')).toBe(
            '839'
        )
    })

    // A fragment or query can contain digits of its own; the /pull/<n> segment is
    // the only trustworthy source, so it must win over a first-number-anywhere match.
    it('ignores digits in a trailing fragment', () => {
        expect(
            parsePrNumber(
                'https://github.com/safeinsights/management-app/pull/839/files#diff-r1234567'
            )
        ).toBe('839')
    })

    it('ignores digits in a query string', () => {
        expect(parsePrNumber('https://github.com/safeinsights/management-app/pull/907?w=1')).toBe(
            '907'
        )
    })

    it('returns empty for empty input', () => {
        expect(parsePrNumber('')).toBe('')
        expect(parsePrNumber('   ')).toBe('')
    })

    // Garbage is returned trimmed rather than silently dropped, so the user sees
    // what they typed reach the engine and gets a real error instead of a no-op.
    it('returns unrecognized input trimmed', () => {
        expect(parsePrNumber(' not-a-pr ')).toBe('not-a-pr')
    })
})

// The Env selector is disabled on the strength of isPrNumber, so a false positive
// strands the user: env locked, and the run pointed at a PR that doesn't exist.
describe('isPrNumber', () => {
    it('is true for a resolvable PR', () => {
        expect(isPrNumber('839')).toBe(true)
        expect(isPrNumber('#839')).toBe(true)
        expect(isPrNumber('https://github.com/safeinsights/management-app/pull/839/files')).toBe(
            true
        )
    })

    it('is false for an empty box', () => {
        expect(isPrNumber('')).toBe(false)
        expect(isPrNumber('   ')).toBe(false)
    })

    // parsePrNumber passes unrecognized text through unchanged, so a truthiness
    // check on its return value would wrongly report these as a PR.
    it('is false for text that never resolved to a number', () => {
        expect(isPrNumber('not-a-pr')).toBe(false)
        expect(isPrNumber('abc')).toBe(false)
    })

    // Typing a URL left-to-right passes through many non-numeric prefixes; none of
    // them should flip the env lock before the number actually lands.
    it('is false for a half-typed URL', () => {
        expect(isPrNumber('https://github.com/safeinsights/management-app/pu')).toBe(false)
        expect(isPrNumber('https://github.com/safeinsights/management-app/pull/')).toBe(false)
    })
})

describe('parseJiraCard', () => {
    it('uppercases a bare key', () => {
        expect(parseJiraCard('otter-640')).toBe('OTTER-640')
    })

    it('pulls the key out of a Jira URL', () => {
        expect(parseJiraCard('https://openstax.atlassian.net/browse/OTTER-640?focused=1')).toBe(
            'OTTER-640'
        )
    })

    it('returns empty for empty input', () => {
        expect(parseJiraCard('')).toBe('')
    })
})

// ciBlocks decides whether the Start button is swapped for "Start anyway". It has
// to agree with PrCIStatus.Blocking() in gui/app.go — Go is the real gate, so a
// disagreement either blocks a start the UI said was fine, or offers a plain Start
// that Go then rejects.
describe('ciBlocks', () => {
    it('blocks while the preview deployment is not green', () => {
        expect(ciBlocks('pending')).toBe(true)
        expect(ciBlocks('failed')).toBe(true)
        expect(ciBlocks('none')).toBe(true)
    })

    it('does not block when CI succeeded', () => {
        expect(ciBlocks('ok')).toBe(false)
    })

    // Being unable to ASK GitHub (offline, gh unauthenticated) is not evidence the
    // deployment is stale; blocking on it would strand a tester with no way forward.
    it('does not block when the status could not be read', () => {
        expect(ciBlocks('unknown')).toBe(false)
    })

    // No probe has resolved yet — the tab renders before the debounced check runs.
    it('does not block before a verdict exists', () => {
        expect(ciBlocks(null)).toBe(false)
        expect(ciBlocks(undefined)).toBe(false)
    })
})
