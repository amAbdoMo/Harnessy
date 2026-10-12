/** Native-app invitation import; possession permits a pairing candidate, never task admission. */
import { decodeBase64Url, encodeBase64Url, exactRecord, parseHttpsOrigin, parseId } from './bytes.ts'
import { derivePcId, parsePublicKey } from './keys.ts'
import type { HttpsOrigin, InvitationId, PcId, PublicKeySpki } from './types.ts'

const PREFIX = 'harnessy://pair#'
const MAX_LINK_BYTES = 4096

/** Transient invitation; never persist or log the secret on the phone. */
export interface PairingInvitation {
  readonly httpsOrigin: HttpsOrigin
  readonly pcId: PcId
  readonly pcIdentityKey: PublicKeySpki
  readonly invitationId: InvitationId
  /** UTC epoch milliseconds; the PC independently enforces expiry and single-use admission. */
  readonly expiresAt: number
  /** Caller-owned decoded 32-byte secret; clear when enrollment finishes or is abandoned. */
  readonly secret: Uint8Array
}

function parseExpiry(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) throw new Error('Invalid invitation expiry')
  return value
}

/**
 * Build a main-only clipboard invitation for the native companion.
 * @param invitation - Validated PC identity, origin, one-time invitation and expiry.
 * @returns Bounded custom-scheme URL; no operator token or persistent PC credential appears in it.
 */
export function encodePairingInvitation(invitation: PairingInvitation): string {
  const httpsOrigin = parseHttpsOrigin(invitation.httpsOrigin)
  const pcIdentityKey = parsePublicKey(invitation.pcIdentityKey)
  if (invitation.pcId !== derivePcId(pcIdentityKey)) throw new Error('Invitation PC identity mismatch')
  const invitationId = parseId<InvitationId>(invitation.invitationId)
  const expiresAt = parseExpiry(invitation.expiresAt)
  if (invitation.secret.byteLength !== 32) throw new Error('Invalid invitation secret')
  const encoded = encodeBase64Url(Buffer.from(JSON.stringify({
    v: 1, httpsOrigin, pcId: invitation.pcId, pcIdentityKey, invitationId, expiresAt,
    secret: encodeBase64Url(invitation.secret),
  }), 'utf8'))
  const link = PREFIX + encoded
  if (Buffer.byteLength(link, 'utf8') > MAX_LINK_BYTES) throw new Error('Invitation link exceeds byte limit')
  return link
}

/**
 * Parse the exact native invitation URL without navigation or network access.
 * @param link - Untrusted pasted URL or Android intent data.
 * @param now - Caller clock in UTC epoch milliseconds, used only for the local expiry check.
 * @returns Caller-owned transient secret and pinned public identity; the PC still requires local approval.
 */
export function parsePairingInvitation(link: string, now: number): PairingInvitation {
  if (Buffer.byteLength(link, 'utf8') > MAX_LINK_BYTES || !link.startsWith(PREFIX)) throw new Error('Invalid invitation link')
  if (!Number.isSafeInteger(now) || now < 0) throw new Error('Invalid invitation clock')
  const bytes = decodeBase64Url(link.slice(PREFIX.length), null, MAX_LINK_BYTES)
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  const candidate: unknown = JSON.parse(text)
  const record = exactRecord(candidate, ['v', 'httpsOrigin', 'pcId', 'pcIdentityKey', 'invitationId', 'expiresAt', 'secret'])
  if (record.v !== 1) throw new Error('Unsupported invitation version')
  const httpsOrigin = parseHttpsOrigin(record.httpsOrigin)
  const pcIdentityKey = parsePublicKey(record.pcIdentityKey)
  const pcId = parseId<PcId>(record.pcId)
  if (pcId !== derivePcId(pcIdentityKey)) throw new Error('Invitation PC identity mismatch')
  const expiresAt = parseExpiry(record.expiresAt)
  if (expiresAt <= now) throw new Error('Invitation expired')
  return {
    httpsOrigin, pcIdentityKey, pcId, expiresAt,
    invitationId: parseId<InvitationId>(record.invitationId),
    secret: decodeBase64Url(record.secret, 32),
  }
}
