import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

// `qar verdict-posted` writes a rendezvous file under resultsRoot() (derived from
// QAR_REPO_DIR) that the running validation session polls. Point QAR_REPO_DIR at a
// temp dir and assert on the file it writes. Import lazily so paths resolve against
// the temp repo.
let repo: string
let priorRepo: string | undefined

beforeEach(() => {
    priorRepo = process.env.QAR_REPO_DIR
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'qar-verdict-'))
    process.env.QAR_REPO_DIR = repo
})

afterEach(() => {
    if (priorRepo === undefined) delete process.env.QAR_REPO_DIR
    else process.env.QAR_REPO_DIR = priorRepo
    fs.rmSync(repo, { recursive: true, force: true })
})

describe('verdict-posted', () => {
    it('writes { issue, result } to the verdict rendezvous file', async () => {
        const { verdictPostedCommand } = await import('@/cli/commands/verdict')
        const { verdictPostedPath } = await import('@/engine/paths')
        await verdictPostedCommand({ issue: 'OTTER-1', result: 'validated' })
        const written = JSON.parse(fs.readFileSync(verdictPostedPath(), 'utf8'))
        expect(written).toEqual({ issue: 'OTTER-1', result: 'validated' })
    })

    it('lowercases + accepts rejected', async () => {
        const { verdictPostedCommand } = await import('@/cli/commands/verdict')
        const { verdictPostedPath } = await import('@/engine/paths')
        await verdictPostedCommand({ issue: 'OTTER-2', result: 'REJECTED' })
        expect(JSON.parse(fs.readFileSync(verdictPostedPath(), 'utf8')).result).toBe('rejected')
    })

    it('rejects a missing issue', async () => {
        const { verdictPostedCommand } = await import('@/cli/commands/verdict')
        await expect(verdictPostedCommand({ result: 'validated' })).rejects.toThrow(/--issue/)
    })

    it('rejects an invalid result', async () => {
        const { verdictPostedCommand } = await import('@/cli/commands/verdict')
        await expect(verdictPostedCommand({ issue: 'OTTER-3', result: 'maybe' })).rejects.toThrow(
            /validated, rejected/
        )
    })
})
