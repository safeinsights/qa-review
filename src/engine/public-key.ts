// Derive the PUBLIC half of a stored results private key.
//
// Settings hold `<ROLE>_RESULTS_PRIVATE_KEY_<ENV>` (a PKCS#8 PEM) — the key a
// reviewer decrypts results with. The management-app stores only the matching
// PUBLIC key, which senders wrap result keys to. When those drift apart, results
// get wrapped to a key we can't unwrap, so `qar fix-account` pushes the public half
// of the key we actually hold. Deriving it (rather than storing a second value)
// means the two can't disagree.

const PEM_BODY = /-----[^-]+-----/g

// RSA-OAEP + SHA-256 — must match si-encryption's wrapAesKey and the management-app's
// assertValidPublicKey, or the server rejects the key as unimportable.
const RSA_OAEP = { name: 'RSA-OAEP', hash: 'SHA-256' } as const

function pemToDer(pem: string): ArrayBuffer {
    const b64 = pem.replace(PEM_BODY, '').replace(/\s+/g, '')
    if (!b64) throw new Error('private key is empty')
    const buf = Buffer.from(b64, 'base64')
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer
}

function derToPem(der: ArrayBuffer, label: string): string {
    const b64 = Buffer.from(der).toString('base64')
    const lines = b64.match(/.{1,64}/g) ?? []
    return `-----BEGIN ${label}-----\n${lines.join('\n')}\n-----END ${label}-----\n`
}

// Given a PKCS#8 private-key PEM, return the matching SPKI public-key PEM.
//
// An RSA public key is just the modulus + exponent of the private one, so this
// round-trips through JWK: export the private key, keep only the public components,
// and re-import as a public key. Throws a clear error if the PEM isn't an importable
// RSA key rather than sending something the server will 400 on.
export async function publicKeyFromPrivatePem(privatePem: string): Promise<string> {
    let priv: CryptoKey
    try {
        priv = await crypto.subtle.importKey('pkcs8', pemToDer(privatePem), RSA_OAEP, true, [
            'decrypt',
        ])
    } catch (cause) {
        throw new Error(
            `results private key is not an importable RSA PKCS#8 PEM: ${(cause as Error).message}`
        )
    }
    const jwk = await crypto.subtle.exportKey('jwk', priv)
    const pub = await crypto.subtle.importKey(
        'jwk',
        { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: jwk.alg, ext: true, key_ops: ['encrypt'] },
        RSA_OAEP,
        true,
        ['encrypt']
    )
    return derToPem(await crypto.subtle.exportKey('spki', pub), 'PUBLIC KEY')
}
