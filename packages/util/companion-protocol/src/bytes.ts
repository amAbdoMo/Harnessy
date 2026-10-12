/** Canonical length-prefixed binary encoding and wire primitive validation. */
import { brandString } from '@deepseek-ai/dsh-brand'
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { Counter, HttpsOrigin } from './types.ts'

/** Maximum encrypted application bytes, excluding the one-byte payload tag. */
export const MAX_APPLICATION_BYTES = 64 * 1024
/**
 * Complete normalized relay JSON ceiling used as the shared PC receiver's minimum capacity.
 * Ciphertext contributes at most 87,383 ASCII bytes; six 128-byte IDs, a 122-byte SPKI,
 * counter/tag fields and 1,024 bytes of fixed JSON remain below 90,000 bytes.
 * Hello/control envelopes are smaller, including worst-case escaping of the bounded origin.
 */
export const MAX_NORMALIZED_RELAY_FRAME_BYTES = 96 * 1024
/** Fixed per-direction invocation cap, including encrypted confirmation. */
export const KEY_USE_LIMIT = 1_048_576n

/**
 * Encode bytes without padding or alternate alphabets.
 * @param bytes - Raw bytes.
 * @returns Canonical base64url text.
 */
export function encodeBase64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url')
}

/**
 * Reject noncanonical base64url before decoding; bounded at the wire parser.
 * @param encoded - Untrusted text.
 * @param length - Required byte length, or null for variable-length fields.
 * @param maximum - Maximum byte length for variable-length fields.
 * @returns Decoded bytes; throws on alphabet, padding, unused bits, or length errors.
 */
export function decodeBase64Url(encoded: unknown, length: number | null, maximum = 65537): Buffer {
  if (typeof encoded !== 'string' || encoded.length > Math.ceil(maximum * 4 / 3)
    || !/^[A-Za-z0-9_-]*$/.test(encoded)) throw new Error('Invalid base64url field')
  const bytes = Buffer.from(encoded, 'base64url')
  if (encodeBase64Url(bytes) !== encoded || bytes.length > maximum
    || (length !== null && bytes.length !== length)) throw new Error('Invalid base64url length or encoding')
  return bytes
}

/**
 * Encode a domain followed by fields as repeated uint32BE-length/raw-byte pairs.
 * @param domain - Protocol domain; encoded exactly as UTF-8, without a terminator.
 * @param fields - Ordered UTF-8 strings or raw byte fields; no JSON is authenticated.
 * @returns Canonical authenticated bytes.
 */
export function canonicalBytes(domain: string, fields: readonly (string | Uint8Array)[]): Buffer {
  const chunks: Buffer[] = []
  for (const field of [domain, ...fields]) {
    const bytes = typeof field === 'string' ? Buffer.from(field, 'utf8') : Buffer.from(field)
    if (bytes.length > 0xffffffff) throw new Error('Canonical field exceeds uint32 length')
    const prefix = Buffer.alloc(4)
    prefix.writeUInt32BE(bytes.length)
    chunks.push(prefix, bytes)
  }
  return Buffer.concat(chunks)
}

/**
 * Encode an unsigned counter as exactly eight big-endian bytes.
 * @param counter - Counter from zero through uint64 maximum.
 * @returns Raw counter bytes; throws on overflow or negative values.
 */
export function counterBytes(counter: bigint): Buffer {
  if (counter < 0n || counter > 0xffffffffffffffffn) throw new Error('Counter outside uint64')
  const bytes = Buffer.alloc(8)
  bytes.writeBigUInt64BE(counter)
  return bytes
}

/**
 * Serialize a counter without JSON number precision loss.
 * @param counter - Unsigned uint64 counter.
 * @returns Canonical branded base64url counter.
 */
export function encodeCounter(counter: bigint): Counter {
  return brandString<Counter>(encodeBase64Url(counterBytes(counter)))
}

/**
 * Parse the wire counter without accepting numbers or shortened encodings.
 * @param encoded - Untrusted field.
 * @returns Unsigned uint64 counter.
 */
export function decodeCounter(encoded: unknown): bigint {
  return decodeBase64Url(encoded, 8).readBigUInt64BE()
}

/**
 * Validate an opaque wire identifier without assigning trust to it.
 * @param identifier - Untrusted identifier.
 * @returns Identifier carrying the caller-selected domain brand.
 */
// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- preserves caller-selected identifier brands
export function parseId<T extends Branded<string>>(identifier: unknown): T {
  if (typeof identifier !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(identifier)) {
    throw new Error('Invalid companion identifier')
  }
  return brandString<T>(identifier)
}

/**
 * Admit only URL.origin's exact canonical HTTPS spelling.
 * @param origin - Untrusted origin; paths, credentials, query, fragments, and slash are rejected.
 * @returns Canonical origin; this does not validate ownership, DNS, or network reachability.
 */
export function parseHttpsOrigin(origin: unknown): HttpsOrigin {
  if (typeof origin !== 'string' || origin.length > 2048) throw new Error('Invalid HTTPS origin')
  const parsed = new URL(origin)
  if (parsed.protocol !== 'https:' || parsed.origin !== origin || parsed.username || parsed.password) {
    throw new Error('Expected canonical HTTPS origin')
  }
  return brandString<HttpsOrigin>(origin)
}

function isRecord(candidate: unknown): candidate is Record<string, unknown> {
  return typeof candidate === 'object' && candidate !== null && !Array.isArray(candidate)
}

/**
 * Reject omitted and extra object keys; callers parse a JSON-decoded value.
 * @param candidate - Untrusted decoded JSON.
 * @param keys - Exact own enumerable field names; order is not significant in JSON.
 * @returns Record for field-by-field validation.
 */
export function exactRecord(candidate: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!isRecord(candidate) || Object.keys(candidate).length !== keys.length
    || !keys.every(key => Object.hasOwn(candidate, key))) throw new Error('Invalid protocol object fields')
  return candidate
}

/**
 * Validate an authorization generation representable identically in Java and JSON.
 * @param generation - Untrusted positive uint32 JSON number.
 * @returns Validated generation.
 */
export function parseGeneration(generation: unknown): number {
  if (typeof generation !== 'number' || !Number.isInteger(generation)
    || generation < 1 || generation > 0xffffffff) throw new Error('Invalid grant generation')
  return generation
}
