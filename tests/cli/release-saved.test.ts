import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

let repo: string
let prior: string | undefined
beforeEach(() => {
    prior = process.env.QAR_REPO_DIR
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'qar-release-saved-'))
    process.env.QAR_REPO_DIR = repo
})
afterEach(() => {
    if (prior === undefined) delete process.env.QAR_REPO_DIR
    else process.env.QAR_REPO_DIR = prior
    fs.rmSync(repo, { recursive: true, force: true })
})

describe('release-saved', () => {
    it('writes { tag, asset, url } to the rendezvous file', async () => {
        const { releaseSavedCommand } = await import('@/cli/commands/release-saved')
        const { releaseSavedPath } = await import('@/engine/paths')
        await releaseSavedCommand({ tag: 'v1', asset: 'testing-plan.md', url: 'https://x' })
        expect(JSON.parse(fs.readFileSync(releaseSavedPath(), 'utf8'))).toEqual({
            tag: 'v1',
            asset: 'testing-plan.md',
            url: 'https://x',
        })
    })

    it('requires --tag and --asset', async () => {
        const { releaseSavedCommand } = await import('@/cli/commands/release-saved')
        await expect(releaseSavedCommand({ asset: 'a' })).rejects.toThrow(/--tag/)
        await expect(releaseSavedCommand({ tag: 'v' })).rejects.toThrow(/--asset/)
    })
})
