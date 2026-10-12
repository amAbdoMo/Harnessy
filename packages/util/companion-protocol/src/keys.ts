/** Node-native P-256 identity primitives; public encodings match Java X509EncodedKeySpec. */
import {
  createHash, createPublicKey, ECDH, generateKeyPairSync, sign, verify,
} from 'node:crypto'
import type { KeyObject } from 'node:crypto'
import { brandString } from '@deepseek-ai/dsh-brand'
import { canonicalBytes, decodeBase64Url, encodeBase64Url } from './bytes.ts'
import type { PcId, PublicKeySpki } from './types.ts'

const SPKI_PREFIX = Buffer.from('3059301306072a8648ce3d020106082a8648ce3d03010703420004', 'hex')
const P256_ORDER = BigInt('0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551')

/**
 * Reject private, trailing, compressed-point, wrong-curve, and noncanonical public encodings.
 * @param encoded - Untrusted unpadded base64url SPKI DER.
 * @returns Validated public KeyObject; throws on malformed or non-P-256 keys.
 */
export function importPublicKey(encoded: unknown): KeyObject {
  const der = decodeBase64Url(encoded, 91, 91)
  if (!der.subarray(0, SPKI_PREFIX.length).equals(SPKI_PREFIX)) throw new Error('Expected canonical P-256 SPKI')
  ECDH.convertKey(der.subarray(SPKI_PREFIX.length - 1), 'prime256v1')
  const key = createPublicKey({ key: der, format: 'der', type: 'spki' })
  if (!key.export({ type: 'spki', format: 'der' }).equals(der)) throw new Error('Noncanonical SPKI')
  return key
}

/**
 * Export only the public P-256 SPKI, including when given a private identity.
 * @param key - Public or private P-256 KeyObject; private bytes never leave this function.
 * @returns Canonical public SPKI base64url.
 */
export function exportPublicKey(key: KeyObject): PublicKeySpki {
  const publicKey = key.type === 'private' ? createPublicKey(key) : key
  if (publicKey.type !== 'public' || publicKey.asymmetricKeyType !== 'ec'
    || publicKey.asymmetricKeyDetails?.namedCurve !== 'prime256v1') throw new Error('Expected P-256 key')
  const encoded = encodeBase64Url(publicKey.export({ format: 'der', type: 'spki' }))
  importPublicKey(encoded)
  return brandString<PublicKeySpki>(encoded)
}

/**
 * Validate and brand a public key field from the wire.
 * @param encoded - Untrusted SPKI text.
 * @returns Canonical public SPKI text.
 */
export function parsePublicKey(encoded: unknown): PublicKeySpki {
  return exportPublicKey(importPublicKey(encoded))
}

/**
 * Generate a P-256 identity or single-handshake ephemeral keypair.
 * @returns Node KeyObjects; the caller owns private-key storage and destruction.
 */
export function generateP256KeyPair(): { publicKey: KeyObject; privateKey: KeyObject } {
  return generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
}

/**
 * Derive the stable PC identifier with a domain distinct from signatures and handshakes.
 * @param identityKey - Canonical public P-256 SPKI text; validated again before hashing.
 * @returns Base64url SHA-256 over LP(domain), LP(raw canonical SPKI).
 */
export function derivePcId(identityKey: PublicKeySpki): PcId {
  const canonicalKey = exportPublicKey(importPublicKey(identityKey))
  return brandString<PcId>(encodeBase64Url(createHash('sha256')
    .update(canonicalBytes('dsh-companion/pc-id/v1', [decodeBase64Url(canonicalKey, 91)]))
    .digest()))
}

function signatureIntegerEnd(der: Buffer, offset: number): number {
  if (der[offset] !== 2) throw new Error('Expected ECDSA DER integer')
  const length = der[offset + 1]
  if (length === undefined || length < 1 || length > 33 || offset + 2 + length > der.length) {
    throw new Error('Invalid ECDSA integer length')
  }
  const bytes = der.subarray(offset + 2, offset + 2 + length)
  const first = bytes[0]
  const second = bytes[1]
  if (first === undefined || first >= 128
    || (first === 0 && (second === undefined || second < 128))) throw new Error('Noncanonical ECDSA integer')
  const scalar = BigInt(`0x${bytes.toString('hex')}`)
  if (scalar === 0n || scalar >= P256_ORDER) throw new Error('ECDSA scalar outside P-256 order')
  return offset + 2 + length
}

/**
 * Decode canonical DER ECDSA (not IEEE-P1363); both high-S and low-S are accepted.
 * @param encoded - Untrusted canonical base64url signature.
 * @returns Canonical DER bytes; throws on extra bytes, invalid scalars, or redundant zeros.
 */
export function decodeSignature(encoded: unknown): Buffer {
  const der = decodeBase64Url(encoded, null, 72)
  if (der[0] !== 0x30 || der[1] !== der.length - 2) throw new Error('Invalid ECDSA DER sequence')
  const rEnd = signatureIntegerEnd(der, 2)
  const sEnd = signatureIntegerEnd(der, rEnd)
  if (sEnd !== der.length) throw new Error('Extra ECDSA DER bytes')
  return der
}

/**
 * Sign authenticated bytes with Node's default DER SHA256withECDSA encoding.
 * @param privateKey - Caller-owned P-256 private key.
 * @param transcript - Domain-separated canonical bytes.
 * @returns Canonical base64url DER signature, compatible with Java SHA256withECDSA.
 */
export function signBytes(privateKey: KeyObject, transcript: Uint8Array): string {
  if (privateKey.type !== 'private') throw new Error('Expected private signing key')
  exportPublicKey(privateKey)
  const signature = encodeBase64Url(sign('sha256', transcript, privateKey))
  decodeSignature(signature)
  return signature
}

/**
 * Verify key possession; malformed keys and signatures throw instead of reporting success.
 * @param publicKey - Canonical public P-256 SPKI.
 * @param transcript - Exact canonical signed bytes.
 * @param signature - Canonical base64url DER signature.
 * @returns Whether the mathematical signature verifies; no trust decision is made.
 */
export function verifyBytes(publicKey: PublicKeySpki, transcript: Uint8Array, signature: unknown): boolean {
  return verify('sha256', transcript, importPublicKey(publicKey), decodeSignature(signature))
}
