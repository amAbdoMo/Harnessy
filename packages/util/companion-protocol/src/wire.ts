/** Strict version-one JSON parsers; unknown fields never become authenticated defaults. */
import {
  decodeBase64Url, encodeBase64Url, encodeCounter, decodeCounter, exactRecord,
  parseGeneration, parseHttpsOrigin, parseId, MAX_APPLICATION_BYTES,
} from './bytes.ts'
import { decodeSignature, parsePublicKey } from './keys.ts'
import type {
  ChannelId, ClientHello, EncryptedFrame, GrantId, HelloAuthorization, InvitationId, PcWelcome,
} from './types.ts'

/** Fixed cryptographic suite; negotiation and downgrades are not supported. */
export const SUITE = 'P256-SHA256-HKDF-A256GCM'

function parseAuthorization(wire: unknown): HelloAuthorization {
  if (typeof wire !== 'object' || wire === null || !('kind' in wire)) throw new Error('Invalid hello authorization')
  if (wire.kind === 'grant') {
    const fields = exactRecord(wire, ['kind', 'grantId', 'generation'])
    return Object.freeze({ kind: 'grant', grantId: parseId<GrantId>(fields.grantId), generation: parseGeneration(fields.generation) })
  }
  if (wire.kind === 'invitation') {
    const fields = exactRecord(wire, ['kind', 'invitationId'])
    return Object.freeze({ kind: 'invitation', invitationId: parseId<InvitationId>(fields.invitationId) })
  }
  throw new Error('Invalid hello authorization kind')
}

/**
 * Parse a phone hello without performing a signature or authorization decision.
 * @param wire - Untrusted decoded JSON.
 * @returns Frozen validated hello.
 */
export function parseClientHello(wire: unknown): ClientHello {
  const fields = exactRecord(wire, [
    'v', 'type', 'suite', 'role', 'httpsOrigin', 'channelId', 'phoneIdentityKey',
    'pcIdentityKey', 'nonce', 'ephemeralKey', 'authorization', 'pairingProof', 'signature',
  ])
  if (fields.v !== 1 || fields.type !== 'hello' || fields.suite !== SUITE || fields.role !== 'phone') {
    throw new Error('Invalid hello version, suite, type, or role')
  }
  const authorization = parseAuthorization(fields.authorization)
  return Object.freeze({
    v: 1, type: 'hello', suite: SUITE, role: 'phone', httpsOrigin: parseHttpsOrigin(fields.httpsOrigin),
    channelId: parseId<ChannelId>(fields.channelId), phoneIdentityKey: parsePublicKey(fields.phoneIdentityKey),
    pcIdentityKey: parsePublicKey(fields.pcIdentityKey), nonce: encodeBase64Url(decodeBase64Url(fields.nonce, 32)),
    ephemeralKey: parsePublicKey(fields.ephemeralKey), authorization,
    pairingProof: encodeBase64Url(decodeBase64Url(fields.pairingProof, authorization.kind === 'invitation' ? 32 : 0)),
    signature: encodeBase64Url(decodeSignature(fields.signature)),
  })
}

/**
 * Parse a PC welcome without trusting its signature.
 * @param wire - Untrusted decoded JSON.
 * @returns Frozen validated welcome.
 */
export function parsePcWelcome(wire: unknown): PcWelcome {
  const fields = exactRecord(wire, ['v', 'type', 'suite', 'role', 'channelId', 'nonce', 'ephemeralKey', 'grantId', 'generation', 'signature'])
  if (fields.v !== 1 || fields.type !== 'welcome' || fields.suite !== SUITE || fields.role !== 'pc') {
    throw new Error('Invalid welcome version, suite, type, or role')
  }
  return Object.freeze({
    v: 1, type: 'welcome', suite: SUITE, role: 'pc', channelId: parseId<ChannelId>(fields.channelId),
    nonce: encodeBase64Url(decodeBase64Url(fields.nonce, 32)), ephemeralKey: parsePublicKey(fields.ephemeralKey),
    grantId: parseId<GrantId>(fields.grantId), generation: parseGeneration(fields.generation),
    signature: encodeBase64Url(decodeSignature(fields.signature)),
  })
}

/**
 * Parse a bounded encrypted JSON frame; authentication occurs in the channel.
 * @param wire - Untrusted decoded JSON; caller bounds raw JSON before parsing.
 * @returns Frozen validated frame.
 */
export function parseEncryptedFrame(wire: unknown): EncryptedFrame {
  const fields = exactRecord(wire, ['v', 'type', 'direction', 'channelId', 'grantId', 'generation', 'counter', 'ciphertext', 'tag'])
  if (fields.v !== 1 || fields.type !== 'encrypted'
    || (fields.direction !== 'phone-to-pc' && fields.direction !== 'pc-to-phone')) throw new Error('Invalid encrypted frame')
  return Object.freeze({
    v: 1, type: 'encrypted', direction: fields.direction, channelId: parseId<ChannelId>(fields.channelId),
    grantId: parseId<GrantId>(fields.grantId), generation: parseGeneration(fields.generation),
    counter: encodeCounter(decodeCounter(fields.counter)),
    ciphertext: encodeBase64Url(decodeBase64Url(fields.ciphertext, null, MAX_APPLICATION_BYTES + 1)),
    tag: encodeBase64Url(decodeBase64Url(fields.tag, 16)),
  })
}
