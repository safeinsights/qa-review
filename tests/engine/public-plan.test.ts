import { describe, expect, it } from 'vitest'
import {
    extractSecurity,
    hasSecurityContent,
    spliceSecurity,
    stripSecurity,
} from '@/engine/public-plan'

const PLAN = `# Regression plan v1

## Summary
Words.

## Baseline
- [BASELINE] Run release-happy-path — qar run

## Changes
### 1. Researcher · no study
- 1.1 t — s ([PR #1](https://github.com/o/r/pull/1))

## Security
- [S-1] Redirect — probe /signin (staging only)
PRs reviewed with no finding: #2

## Technical appendix
### #1 x
Files.
`

const WITHOUT = `# Regression plan v1

## Summary
Words.

## Baseline
- [BASELINE] Run release-happy-path — qar run

## Changes
### 1. Researcher · no study
- 1.1 t — s ([PR #1](https://github.com/o/r/pull/1))

## Technical appendix
### #1 x
Files.
`

describe('stripSecurity', () => {
    it('removes the Security heading through the line before the next section', () => {
        expect(stripSecurity(PLAN)).toBe(WITHOUT)
    })

    it('keeps CRLF endings byte-exact', () => {
        const crlf = PLAN.replace(/\n/g, '\r\n')
        expect(stripSecurity(crlf)).toBe(WITHOUT.replace(/\n/g, '\r\n'))
    })

    it('removes a Security section that is the last one, through the end', () => {
        const last = `## Summary\nA\n\n## Security\n- [S-1] t — p\n`
        expect(stripSecurity(last)).toBe('## Summary\nA\n\n')
    })

    it('returns a plan with no Security section unchanged', () => {
        expect(stripSecurity(WITHOUT)).toBe(WITHOUT)
        const noNewline = 'line one\nline two'
        expect(stripSecurity(noNewline)).toBe(noNewline)
    })
})

describe('hasSecurityContent', () => {
    it('sees an S- bullet, a Security heading, or an S- results row', () => {
        expect(hasSecurityContent(PLAN)).toBe(true)
        expect(hasSecurityContent('- [S-12] t — p')).toBe(true)
        expect(hasSecurityContent('x\r\n## Security\r\ny')).toBe(true)
        expect(hasSecurityContent('| S-1 | Redirect | PASS | ok |')).toBe(true)
    })

    it('sees an S- id anywhere, any bullet marker, and a Security heading at any depth', () => {
        expect(hasSecurityContent('See S-1 in the notes')).toBe(true)
        expect(hasSecurityContent('{"id":"S-3","title":"t"}')).toBe(true)
        expect(hasSecurityContent('* [S-2] t — p')).toBe(true)
        expect(hasSecurityContent('+ [S-2] t — p')).toBe(true)
        expect(hasSecurityContent('    - [S-2] t — p')).toBe(true)
        expect(hasSecurityContent('### Security\nx')).toBe(true)
        expect(hasSecurityContent('## security\nx')).toBe(true)
        expect(hasSecurityContent('#### SECURITY notes\nx')).toBe(true)
    })

    it('is false for the stripped plan and for ids that only contain S-', () => {
        expect(hasSecurityContent(WITHOUT)).toBe(false)
        expect(hasSecurityContent('OTTERS-12 and HTTPS-2 and R-1-1\nsecurity in prose')).toBe(false)
    })
})

const SECTION = `## Security
- [S-1] Redirect — probe /signin (staging only)
PRs reviewed with no finding: #2

`

describe('extractSecurity / spliceSecurity', () => {
    it('extracts exactly the bytes stripSecurity removes', () => {
        expect(extractSecurity(PLAN)).toBe(SECTION)
        expect(extractSecurity(WITHOUT)).toBe('')
    })

    it('puts the section back after Changes, before the Technical appendix', () => {
        expect(spliceSecurity(WITHOUT, SECTION)).toBe(PLAN)
        expect(stripSecurity(spliceSecurity(WITHOUT, SECTION))).toBe(WITHOUT)
    })

    it('keeps CRLF and appends when the plan has no later section', () => {
        const crlf = PLAN.replace(/\n/g, '\r\n')
        const crlfWithout = WITHOUT.replace(/\n/g, '\r\n')
        expect(spliceSecurity(crlfWithout, extractSecurity(crlf))).toBe(crlf)
        expect(spliceSecurity('## Changes\nA\n', '## Security\n- [S-1] t')).toBe(
            '## Changes\nA\n## Security\n- [S-1] t'
        )
        expect(spliceSecurity(WITHOUT, '')).toBe(WITHOUT)
    })
})
