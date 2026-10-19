import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchDeployedRelease, parseReleaseRows } from '@/engine/release'

// Trimmed from the real QA /about page: two rows, and the RSC payload repeats both
// links in escaped JSON, which must not add rows.
const ABOUT =
    '<div class="t">Release<!-- -->:</div><div><a href="https://github.com/safeinsights/management-app/releases/tag/f29abfb" target="_blank">f29abfb</a></div>' +
    '<div class="t">Editor Release<!-- -->:</div><div><a href="https://github.com/safeinsights/management-app/commit/023acfa" target="_blank">023acfa</a></div>' +
    '<script>{\\"href\\":\\"https://github.com/safeinsights/management-app/commit/023acfa\\"}</script>'

describe('parseReleaseRows', () => {
    it('names each repo link by the row label before it', () => {
        expect(parseReleaseRows(ABOUT)).toEqual([
            {
                label: 'Release',
                kind: 'tag',
                ref: 'f29abfb',
                url: 'https://github.com/safeinsights/management-app/releases/tag/f29abfb',
            },
            {
                label: 'Editor Release',
                kind: 'commit',
                ref: '023acfa',
                url: 'https://github.com/safeinsights/management-app/commit/023acfa',
            },
        ])
    })
})

describe('fetchDeployedRelease', () => {
    afterEach(() => vi.unstubAllGlobals())

    it('returns the "Release" row, not the editor one', async () => {
        const fetchMock = vi.fn().mockResolvedValue(new Response(ABOUT, { status: 200 }))
        vi.stubGlobal('fetch', fetchMock)
        const result = await fetchDeployedRelease('https://app.qa.safeinsights.org/')
        expect(fetchMock.mock.calls[0][0]).toBe('https://app.qa.safeinsights.org/about')
        expect(result.release.ref).toBe('f29abfb')
    })

    // An unknown route returns the app shell with 200, so a missing row must fail
    // rather than report nothing as a release.
    it('fails when the page has no Release row', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('<html></html>')))
        await expect(fetchDeployedRelease('https://pr9.qa.safeinsights.org')).rejects.toThrow(
            /No "Release" row .*rows found: none/
        )
    })

    it('names the host it could not reach', async () => {
        vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')))
        await expect(fetchDeployedRelease('https://pr9.qa.safeinsights.org')).rejects.toThrow(
            /Could not reach pr9\.qa\.safeinsights\.org/
        )
    })
})
