import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanupCommand, resolveToken } from '@/cli/commands/cleanup'

const STUDY = '01a20ee2-df1e-7538-b33b-5da805ec1563'
const VARS = { QA_BASE_URL: 'https://app.qa.example.org' }

function tokenFile(contents: string): string {
    const path = join(mkdtempSync(join(tmpdir(), 'qar-cleanup-')), 'token.json')
    writeFileSync(path, contents)
    return path
}

describe('resolveToken', () => {
    it('takes --token, and --cookie as its legacy alias', () => {
        expect(resolveToken({ token: 'abc' })).toBe('abc')
        expect(resolveToken({ cookie: 'abc' })).toBe('abc')
    })

    it('reads a bare token from --token-file', () => {
        expect(resolveToken({ 'token-file': tokenFile('eyJ.abc.def\n') })).toBe('eyJ.abc.def')
    })

    // evaluate_script's `filePath` saves the return value as a JSON string.
    it('unwraps the JSON string evaluate_script writes', () => {
        expect(resolveToken({ 'token-file': tokenFile('"eyJ.abc.def"') })).toBe('eyJ.abc.def')
    })

    // An empty token used to be sent as "Bearer " and came back as a bare 401.
    it('refuses a missing or blank token, saying how to get one', () => {
        expect(() => resolveToken({})).toThrow(/admin token is required.*getToken/s)
        expect(() => resolveToken({ token: '  ' })).toThrow(/admin token is required/)
        expect(() => resolveToken({ 'token-file': tokenFile('""') })).toThrow(
            /admin token is required/
        )
    })

    it('refuses --token together with --token-file', () => {
        expect(() => resolveToken({ token: 'a', 'token-file': tokenFile('b') })).toThrow(/not both/)
    })
})

describe('cleanupCommand', () => {
    afterEach(() => {
        vi.unstubAllGlobals()
        process.exitCode = undefined
    })

    function stubFetch(status: number, body: unknown) {
        const fetchMock = vi.fn(
            async () =>
                new Response(JSON.stringify(body), {
                    status,
                    headers: { 'content-type': 'application/json' },
                })
        )
        vi.stubGlobal('fetch', fetchMock)
        return fetchMock
    }

    it('refuses malformed ids before sending anything', async () => {
        const fetchMock = stubFetch(404, { error: 'not found' })
        await expect(
            cleanupCommand({ token: 't', studies: `${STUDY},nope`, users: 'bad id' }, VARS)
        ).rejects.toThrow(/study "nope", user "bad id".*Nothing was deleted/)
        expect(fetchMock).not.toHaveBeenCalled()
    })

    it('refuses a call with no ids', async () => {
        await expect(cleanupCommand({ token: 't' }, VARS)).rejects.toThrow(/Nothing to delete/)
    })

    it('rejects a bad PR number', async () => {
        stubFetch(200, {})
        await expect(
            cleanupCommand({ token: 't', pr: 'abc', studies: STUDY }, VARS)
        ).rejects.toThrow(/Invalid PR number/)
    })

    // Cleanup never signs in, so it must work with no account secrets configured.
    it('deletes with only the base URL configured, sending the trimmed id', async () => {
        const fetchMock = stubFetch(200, { deleted: STUDY })
        const log = vi.spyOn(console, 'log').mockImplementation(() => {})

        await cleanupCommand({ token: 't', studies: ` ${STUDY} ` }, VARS)

        expect(fetchMock).toHaveBeenCalledWith(
            `https://app.qa.example.org/api/qa/studies/${STUDY}`,
            expect.objectContaining({ method: 'DELETE' })
        )
        expect(JSON.parse(log.mock.calls[0][0] as string).ok).toBe(true)
        expect(process.exitCode).toBeUndefined()
        log.mockRestore()
    })

    it('exits non-zero and explains a 401', async () => {
        stubFetch(401, { error: 'Authentication required' })
        const log = vi.spyOn(console, 'log').mockImplementation(() => {})
        const err = vi.spyOn(console, 'error').mockImplementation(() => {})

        await cleanupCommand({ token: 'expired', studies: STUDY }, VARS)

        expect(process.exitCode).toBe(1)
        expect(err.mock.calls[0][0]).toMatch(/missing, expired or invalid/)
        log.mockRestore()
        err.mockRestore()
    })
})
