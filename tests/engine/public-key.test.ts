import { describe, expect, it } from 'vitest'
import { publicKeyFromPrivatePem } from '@/engine/public-key'

const RSA_OAEP = { name: 'RSA-OAEP', hash: 'SHA-256' } as const

function toPem(der: ArrayBuffer, label: string): string {
    const b64 = Buffer.from(der).toString('base64')
    return `-----BEGIN ${label}-----\n${(b64.match(/.{1,64}/g) ?? []).join('\n')}\n-----END ${label}-----\n`
}

async function generatePrivatePem(): Promise<{ pem: string; key: CryptoKey }> {
    const pair = await crypto.subtle.generateKey(
        { ...RSA_OAEP, modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]) },
        true,
        ['encrypt', 'decrypt']
    )
    const pkcs8 = await crypto.subtle.exportKey('pkcs8', pair.privateKey)
    return { pem: toPem(pkcs8, 'PRIVATE KEY'), key: pair.privateKey }
}

function pemToDer(pem: string): ArrayBuffer {
    const b64 = pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '')
    const buf = Buffer.from(b64, 'base64')
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer
}

describe('publicKeyFromPrivatePem', () => {
    it('derives a public key the management-app accepts', async () => {
        const { pem } = await generatePrivatePem()
        const publicPem = await publicKeyFromPrivatePem(pem)
        expect(publicPem).toMatch(/^-----BEGIN PUBLIC KEY-----\n/)
        expect(publicPem.trimEnd()).toMatch(/-----END PUBLIC KEY-----$/)
        // This is verbatim the server's assertValidPublicKey check — if it throws,
        // the endpoint would reject the key with a 400.
        await expect(
            crypto.subtle.importKey('spki', pemToDer(publicPem), RSA_OAEP, false, ['encrypt'])
        ).resolves.toBeDefined()
    })

    // The property that actually matters: results wrapped to the derived public key
    // must be unwrappable with the private key we hold in settings. If these ever
    // diverge, fixing "drift" would itself orphan every result.
    it('derives the MATCHING half — encrypt to it, decrypt with the private key', async () => {
        const { pem, key: privateKey } = await generatePrivatePem()
        const publicPem = await publicKeyFromPrivatePem(pem)
        const publicKey = await crypto.subtle.importKey(
            'spki',
            pemToDer(publicPem),
            RSA_OAEP,
            false,
            ['encrypt']
        )
        const plaintext = new TextEncoder().encode('results-key-check')
        const ciphertext = await crypto.subtle.encrypt({ name: 'RSA-OAEP' }, publicKey, plaintext)
        const round = await crypto.subtle.decrypt({ name: 'RSA-OAEP' }, privateKey, ciphertext)
        expect(new TextDecoder().decode(round)).toBe('results-key-check')
    })

    it('is deterministic — the same private key always yields the same public key', async () => {
        const { pem } = await generatePrivatePem()
        expect(await publicKeyFromPrivatePem(pem)).toBe(await publicKeyFromPrivatePem(pem))
    })

    it('tolerates surrounding whitespace in the stored PEM', async () => {
        const { pem } = await generatePrivatePem()
        const padded = `\n  ${pem.trim()}  \n`
        expect(await publicKeyFromPrivatePem(padded)).toBe(await publicKeyFromPrivatePem(pem))
    })

    it('fails with a clear message on a non-key value', async () => {
        await expect(publicKeyFromPrivatePem('not a key')).rejects.toThrow(
            /not an importable RSA PKCS#8 PEM/
        )
        await expect(publicKeyFromPrivatePem('')).rejects.toThrow(/empty/)
    })
})
