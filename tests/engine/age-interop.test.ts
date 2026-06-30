import { describe, it, expect, beforeAll } from 'vitest'
import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { encryptValue, decryptValue } from '@/engine/settings'

// Verifies the Go GUI (filippo.io/age) and the TS engine (age-encryption) produce
// interoperable passphrase-encrypted blobs. Builds the small `agecrypt` Go helper
// (gui/cmd/agecrypt) once, then crosses each direction.

const here = path.dirname(fileURLToPath(import.meta.url))
const guiDir = path.resolve(here, '../../gui')
const PASS = 'interop-pass-9000'

let bin: string
let goAvailable = true

beforeAll(() => {
    bin = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'agecrypt-')), 'agecrypt')
    try {
        execFileSync('go', ['build', '-o', bin, './cmd/agecrypt'], { cwd: guiDir, stdio: 'pipe' })
    } catch (e) {
        // No Go toolchain in this environment — skip rather than fail the suite.
        goAvailable = false
    }
}, 60_000)

function goEncrypt(plaintext: string): string {
    return execFileSync(bin, ['encrypt', PASS], { input: plaintext }).toString()
}
function goDecrypt(armored: string): string {
    return execFileSync(bin, ['decrypt', PASS], { input: armored }).toString()
}

describe('age cross-language interop', () => {
    it('TS decrypts a Go-encrypted value', async () => {
        if (!goAvailable) return
        const armored = goEncrypt('hello-from-go')
        expect(await decryptValue(armored, PASS)).toBe('hello-from-go')
    })

    it('Go decrypts a TS-encrypted value', async () => {
        if (!goAvailable) return
        const armored = await encryptValue('hello-from-ts', PASS)
        expect(goDecrypt(armored)).toBe('hello-from-ts')
    })
})
