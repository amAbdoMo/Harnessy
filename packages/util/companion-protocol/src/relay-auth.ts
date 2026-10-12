/** Relay key-possession proof; pending challenge ownership and one-time consumption belong to the relay. */
import { randomBytes } from 'node:crypto'
import type { KeyObject } from 'node:crypto'
import { canonicalBytes, decodeBase64Url, encodeBase64Url, exactRecord, parseHttpsOrigin, parseId } from './bytes.ts'
import { derivePcId, exportPublicKey, parsePublicKey, signBytes, verifyBytes } from './keys.ts'
import type { PcId, RelayChallenge, RelayChallengeProof, SocketGeneration } from './types.ts'

/**
 * Parse a challenge without accepting additional or defaulted fields.
 * @param wire - Untrusted decoded JSON.
 * @returns Validated challenge; this does not establish challenge freshness.
 */
export function parseRelayChallenge(wire: unknown): RelayChallenge {
  const fields = exactRecord(wire, ['v', 'type', 'role', 'httpsOrigin', 'identityKey', 'targetPcId', 'socketGeneration', 'challenge'])
  if (fields.v !== 1 || fields.type !== 'relay-challenge' || (fields.role !== 'pc' && fields.role !== 'phone')) {
    throw new Error('Invalid relay challenge version, type, or role')
  }
  const targetPcId = parseId<PcId>(fields.targetPcId)
  decodeBase64Url(targetPcId, 32)
  const identityKey = parsePublicKey(fields.identityKey)
  if (fields.role === 'pc' && derivePcId(identityKey) !== targetPcId) throw new Error('PC relay target differs from identity')
  return Object.freeze({
    v: 1, type: 'relay-challenge', role: fields.role, httpsOrigin: parseHttpsOrigin(fields.httpsOrigin),
    identityKey, targetPcId, socketGeneration: parseId<SocketGeneration>(fields.socketGeneration),
    challenge: encodeBase64Url(decodeBase64Url(fields.challenge, 32)),
  })
}

/**
 * Mint a fresh random challenge for a caller-assigned pending socket generation.
 * @param request - All challenge fields except fixed version/type and random challenge.
 * @returns Validated challenge; relay must store it, expire it, and consume it once.
 */
export function createRelayChallenge(request: Omit<RelayChallenge, 'v' | 'type' | 'challenge'>): RelayChallenge {
  return parseRelayChallenge({ ...request, v: 1, type: 'relay-challenge', challenge: encodeBase64Url(randomBytes(32)) })
}

/**
 * Produce the interoperable relay proof transcript.
 * @param challenge - Validated relay challenge.
 * @returns LP domain and ordered version, role, origin, SPKI, target, socket, challenge bytes.
 */
export function relayChallengeBytes(challenge: RelayChallenge): Buffer {
  return canonicalBytes('dsh-companion/relay-proof/v1', [
    '1', challenge.role, challenge.httpsOrigin, decodeBase64Url(challenge.identityKey, 91),
    decodeBase64Url(challenge.targetPcId, 32), challenge.socketGeneration, decodeBase64Url(challenge.challenge, 32),
  ])
}

/**
 * Sign only a challenge bound to the signing identity.
 * @param privateKey - Caller-owned P-256 identity private key.
 * @param challenge - Challenge received on the intended authenticated-origin connection.
 * @returns Key-possession proof; caller must separately check expected role, origin, target and socket.
 */
export function signRelayChallenge(privateKey: KeyObject, challenge: RelayChallenge): RelayChallengeProof {
  const parsed = parseRelayChallenge(challenge)
  if (exportPublicKey(privateKey) !== parsed.identityKey) throw new Error('Relay challenge identity mismatch')
  return Object.freeze({ v: 1, type: 'relay-proof', signature: signBytes(privateKey, relayChallengeBytes(parsed)) })
}

/**
 * Verify against the stored challenge, never a challenge supplied alongside a proof.
 * @param expected - Relay-owned pending challenge for this exact socket incarnation.
 * @param wireProof - Untrusted decoded proof JSON.
 * @returns Whether the signature verifies; relay must atomically consume/expire the challenge itself.
 */
export function verifyRelayChallenge(expected: RelayChallenge, wireProof: unknown): boolean {
  const proof = exactRecord(wireProof, ['v', 'type', 'signature'])
  if (proof.v !== 1 || proof.type !== 'relay-proof') throw new Error('Invalid relay proof version or type')
  const challenge = parseRelayChallenge(expected)
  return verifyBytes(challenge.identityKey, relayChallengeBytes(challenge), proof.signature)
}
