import { describe, expect, it } from 'vitest'
import { hasSecurityContent, stripSecurity } from '@/engine/public-plan'

const PLAN = `# Regression plan v1

## Summary
Words.

## Baseline
- [BASELINE] Run release-happy-path — qar run

## Changes
### #1 x [high]
- [R-1-1] t — s

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
### #1 x [high]
- [R-1-1] t — s

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

    it('is false for the stripped plan and for a mention in prose', () => {
        expect(hasSecurityContent(WITHOUT)).toBe(false)
        expect(hasSecurityContent('See [S-1] in the notes\n### Security notes')).toBe(false)
    })
})
