/** Wire primitive rejection and Java-compatible key/signature encodings. */
import { createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  canonicalBytes, counterBytes, decodeBase64Url, decodeCounter, decodeSignature, derivePcId,
  encodeBase64Url, encodeCounter, exportPublicKey, generateP256KeyPair, importPublicKey,
  MAX_APPLICATION_BYTES, MAX_NORMALIZED_RELAY_FRAME_BYTES, parseEncryptedFrame,
  parseGeneration, parseHttpsOrigin, signBytes, verifyBytes,
} from '../src/index.ts'

describe('canonical companion primitives', () => {
  it('length-prefixes domains and raw/UTF-8 fields without separator collisions', () => {
    expect(canonicalBytes('d', ['é', Buffer.from([0, 255])]).toString('hex')).toBe('000000016400000002c3a90000000200ff')
    expect(canonicalBytes('d', ['ab', 'c'])).not.toEqual(canonicalBytes('d', ['a', 'bc']))
    expect(canonicalBytes('d', ['x'])).not.toEqual(canonicalBytes('other', ['x']))
  })

  it.each(['AA=', 'AA==', 'AB', '+w', '/w', 'A', 'é', ' AA', 'AA\n'])('rejects noncanonical base64url %j', (encoded) => {
    expect(() => decodeBase64Url(encoded, null)).toThrow()
  })

  it('round-trips zero and uint64 maximum without JSON number conversion', () => {
    for (const counter of [0n, 1n, 0x10000000000000n, 0xffffffffffffffffn]) {
      expect(decodeCounter(encodeCounter(counter))).toBe(counter)
      expect(counterBytes(counter).length).toBe(8)
    }
    expect(encodeCounter(0n)).toBe('AAAAAAAAAAA')
    expect(encodeCounter(0xffffffffffffffffn)).toBe('__________8')
    for (const encoded of [0, 'AA', 'AAAAAAAAAAA=', 'AAAAAAAAAAAAAAAAAAAAAA']) {
      expect(() => decodeCounter(encoded)).toThrow()
    }
    expect(() => encodeCounter(-1n)).toThrow()
    expect(() => encodeCounter(0x10000000000000000n)).toThrow()
  })

  it.each([
    'http://relay.example', 'https://relay.example/', 'https://relay.example/path',
    'https://user@relay.example', 'https://relay.example?x=1', 'https://relay.example#x',
    'https://RELAY.example', 'https://relay.example:443', ' https://relay.example',
  ])('rejects noncanonical or non-HTTPS origin %s', (origin) => {
    expect(() => parseHttpsOrigin(origin)).toThrow()
  })

  it.each([0, -1, 1.1, 0x100000000, '1', null])('rejects unsupported authorization generation %j', (generation) => {
    expect(() => parseGeneration(generation)).toThrow()
  })

  it('rejects private, extra, malformed-point, alternate-curve and PEM public-key fields', () => {
    const { privateKey, publicKey } = generateP256KeyPair()
    const canonical = exportPublicKey(publicKey)
    const der = decodeBase64Url(canonical, 91)
    const wrongCurve = generateKeyPairSync('ec', { namedCurve: 'secp384r1' })
    const badPoint = Buffer.from(der)
    badPoint.fill(0, 27)
    const rejected: readonly unknown[] = [
      encodeBase64Url(privateKey.export({ format: 'der', type: 'pkcs8' })),
      encodeBase64Url(Buffer.concat([der, Buffer.from([0])])), encodeBase64Url(badPoint),
      encodeBase64Url(wrongCurve.publicKey.export({ format: 'der', type: 'spki' })),
      publicKey.export({ format: 'pem', type: 'spki' }), {},
    ]
    for (const encoded of rejected) expect(() => importPublicKey(encoded)).toThrow()
    expect(exportPublicKey(privateKey)).toBe(canonical)
    expect(exportPublicKey(importPublicKey(canonical))).toBe(canonical)
    expect(derivePcId(canonical)).toBe(derivePcId(exportPublicKey(privateKey)))
  })

  it.each(['phone-to-pc', 'pc-to-phone'] as const)(
    'fits a maximum normalized %s encrypted relay envelope inside the shared receiver floor', (direction) => {
      const maximumId = 'x'.repeat(128)
      const payload = parseEncryptedFrame({ v: 1, type: 'encrypted', direction,
        channelId: maximumId, grantId: maximumId, generation: 0xffffffff,
        counter: encodeCounter(0xffffffffffffffffn),
        ciphertext: encodeBase64Url(Buffer.alloc(MAX_APPLICATION_BYTES + 1)), tag: encodeBase64Url(Buffer.alloc(16)) })
      const sourceIdentityKey = exportPublicKey(generateP256KeyPair().publicKey)
      const forwarded = { v: 1, type: 'relay-data', channelId: maximumId, targetPcId: maximumId,
        sourceRole: direction === 'phone-to-pc' ? 'phone' : 'pc', sourceIdentityKey,
        sourceSocketGeneration: maximumId, targetSocketGeneration: maximumId, payload }
      expect(Buffer.byteLength(JSON.stringify(forwarded))).toBeLessThanOrEqual(MAX_NORMALIZED_RELAY_FRAME_BYTES)
      expect(() => parseEncryptedFrame({ ...payload,
        ciphertext: encodeBase64Url(Buffer.alloc(MAX_APPLICATION_BYTES + 2)) })).toThrow()
    },
  )

  it('uses DER SHA256withECDSA signatures with raw Node/JCA-compatible SPKI verification', () => {
    const keys = generateP256KeyPair()
    const publicKey = exportPublicKey(keys.publicKey)
    const transcript = canonicalBytes('test/domain', ['phone', Buffer.alloc(32, 5)])
    const signature = signBytes(keys.privateKey, transcript)
    const imported = createPublicKey({ key: decodeBase64Url(publicKey, 91), format: 'der', type: 'spki' })
    expect(verify('sha256', transcript, imported, decodeSignature(signature))).toBe(true)
    const nativeSignature = encodeBase64Url(sign('sha256', transcript, keys.privateKey))
    expect(verifyBytes(publicKey, transcript, nativeSignature)).toBe(true)
    expect(verifyBytes(publicKey, canonicalBytes('test/other', ['phone', Buffer.alloc(32, 5)]), signature)).toBe(false)
    expect(() => decodeSignature(encodeBase64Url(Buffer.concat([decodeSignature(signature), Buffer.from([0])])))).toThrow()
    for (const invalidDer of ['3006020100020101', '300702020001020101', '3006020180020101', '308106020101020101']) {
      expect(() => decodeSignature(encodeBase64Url(Buffer.from(invalidDer, 'hex')))).toThrow()
    }
  })
})
