import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeAll, describe, expect, it } from 'vitest'
import {
    decryptWithIdentity,
    encryptToRecipients,
    generateIdentity,
    publicKeyFromIdentity,
} from '@/engine/settings'

const here = path.dirname(fileURLToPath(import.meta.url))
const guiDir = path.resolve(here, '../../gui')

let bin: string
let goAvailable = true

beforeAll(() => {
    bin = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'agecrypt-')), 'agecrypt')
    try {
        execFileSync('go', ['build', '-o', bin, './cmd/agecrypt'], { cwd: guiDir, stdio: 'pipe' })
    } catch {
        goAvailable = false
    }
}, 60_000)

describe('age X25519 cross-language interop', () => {
    it('TS decrypts a Go-encrypted value', async () => {
        if (!goAvailable) return
        const id = await generateIdentity()
        const pub = await publicKeyFromIdentity(id)
        const armored = execFileSync(bin, ['encrypt', pub], { input: 'hello-from-go' }).toString()
        expect(await decryptWithIdentity(armored, id)).toBe('hello-from-go')
    })

    it('Go decrypts a TS-encrypted value', async () => {
        if (!goAvailable) return
        const id = await generateIdentity()
        const pub = await publicKeyFromIdentity(id)
        const armored = await encryptToRecipients('hello-from-ts', [pub])
        const out = execFileSync(bin, ['decrypt', id], { input: armored }).toString()
        expect(out).toBe('hello-from-ts')
    })
})
