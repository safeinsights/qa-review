import { describe, expect, it } from 'vitest'
import { parseRelatedRepos, relatedReleasesSection } from '@/engine/release-notes'
import { spliceWithPlacement } from '@/engine/release-summary'

describe('parseRelatedRepos', () => {
    it('keeps the configured order', () => {
        expect(parseRelatedRepos('a/b=B, c/d=D Lib')).toEqual([
            { repo: 'a/b', label: 'B' },
            { repo: 'c/d', label: 'D Lib' },
        ])
    })

    it('rejects a pair with no label', () => {
        expect(() => parseRelatedRepos('a/b')).toThrow(/owner\/repo=Label/)
    })
})

describe('relatedReleasesSection', () => {
    it('takes the summary after it, in the v1.7.0 layout', () => {
        const section = relatedReleasesSection([
            { repo: 'safeinsights/setup-app', label: 'Setup App', tag: 'v1.2.5' },
        ])
        const { body, placement } = spliceWithPlacement(section, 'v1.7.0 holds 73 PRs.')
        expect(placement).toBe('appended')
        expect(body).toBe(
            [
                '## Related Releases',
                '',
                '- [Setup App v1.2.5](https://github.com/safeinsights/setup-app/releases/tag/v1.2.5)',
                '',
                '<!-- regression-summary -->',
                '## What changed',
                'v1.7.0 holds 73 PRs.',
                '<!-- /regression-summary -->',
                '',
            ].join('\n')
        )
        expect(body).not.toContain('| PR #')
    })
})
