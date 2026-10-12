/** Fresh authenticated P-256 ECDH handshakes; PC grant/invitation authorization is explicitly external. */
import { createHmac, diffieHellman, randomBytes, timingSafeEqual } from 'node:crypto'
import type { KeyObject } from 'node:crypto'
import { decodeBase64Url, encodeBase64Url, parseGeneration, parseId } from './bytes.ts'
import { createChannel } from './channel.ts'
import type { EncryptedChannel } from './channel.ts'
import { parseChannelBudget } from './channel-budget.ts'
import type { ChannelBudget } from './channel-budget.ts'
import { exportPublicKey, generateP256KeyPair, importPublicKey, signBytes, verifyBytes } from './keys.ts'
import { helloSignatureBytes, unsignedHelloBytes, welcomeSignatureBytes } from './transcripts.ts'
import { parseClientHello, parsePcWelcome, SUITE } from './wire.ts'
import type {
  ChannelId, ClientHello, GrantId, HelloAuthorization, HttpsOrigin, InvitationId,
  PcWelcome, PublicKeySpki, UnsignedClientHello, UnsignedPcWelcome,
} from './types.ts'

/** Caller-resolved phone credentials; invitation secrets are never sent directly. */
export type PhoneAuthorization =
  | { readonly kind: 'grant'; readonly grantId: GrantId; readonly generation: number }
  | { readonly kind: 'invitation'; readonly invitationId: InvitationId; readonly pairingSecret: Uint8Array }

/** PC-owned authorization decision for exactly this phone and referenced grant/invitation. */
export type AuthorizedHandshake = {
  readonly phoneIdentityKey: PublicKeySpki
  readonly grantId: GrantId
  readonly generation: number
} & (
  | { readonly kind: 'grant' }
  | { readonly kind: 'invitation'; readonly invitationId: InvitationId; readonly pairingSecret: Uint8Array }
)

/** One fresh phone attempt; every completion attempt, including failure, consumes it. */
export interface PhoneHandshake {
  /** Complete signed hello; send only on this attempt's intended origin and route. */
  readonly hello: ClientHello
  /**
   * Authenticate the welcome against the pinned PC identity and consume the ephemeral private key.
   * @param wire - Untrusted decoded welcome JSON.
   * @returns Unconfirmed encrypted channel; throws permanently on mismatch.
   */
  complete(wire: unknown): EncryptedChannel
  /** Release the ephemeral private KeyObject reference without completing the handshake. */
  close(): void
}

/** Explicit phone inputs; identity trust and invitation receipt validation are caller duties. */
export interface PhoneHandshakeRequest {
  readonly identityPrivateKey: KeyObject
  readonly pcIdentityKey: PublicKeySpki
  readonly httpsOrigin: HttpsOrigin
  readonly channelId: ChannelId
  readonly authorization: PhoneAuthorization
  /** Required endpoint-local queue and write limits; validated before ephemeral key generation. */
  readonly channelBudget: ChannelBudget
}

function pairingProof(secret: Uint8Array, hello: UnsignedClientHello): Buffer {
  if (secret.length !== 32) throw new Error('Expected pairing secret32')
  return createHmac('sha256', secret).update(unsignedHelloBytes(hello)).digest()
}

function authorizationReference(authorization: PhoneAuthorization): HelloAuthorization {
  return authorization.kind === 'grant'
    ? { kind: 'grant', grantId: authorization.grantId, generation: authorization.generation }
    : { kind: 'invitation', invitationId: authorization.invitationId }
}

/**
 * Generate fresh phone nonce32 and ephemeral P-256 keypair, then sign the proof-bound hello.
 * @param request - Explicit caller-owned identity, pinned PC key, origin, route, and authorization reference.
 * @returns A single-use pending handshake; no application bytes may be sent until mutual confirmation.
 */
export function createPhoneHandshake(request: PhoneHandshakeRequest): PhoneHandshake {
  const channelBudget = parseChannelBudget(request.channelBudget)
  const ephemeral = generateP256KeyPair()
  const unsigned: UnsignedClientHello = {
    v: 1, type: 'hello', suite: SUITE, role: 'phone', httpsOrigin: request.httpsOrigin,
    channelId: request.channelId, phoneIdentityKey: exportPublicKey(request.identityPrivateKey),
    pcIdentityKey: exportPublicKey(importPublicKey(request.pcIdentityKey)), nonce: encodeBase64Url(randomBytes(32)),
    ephemeralKey: exportPublicKey(ephemeral.publicKey), authorization: authorizationReference(request.authorization),
  }
  const proofBound = { ...unsigned, pairingProof: request.authorization.kind === 'invitation'
    ? encodeBase64Url(pairingProof(request.authorization.pairingSecret, unsigned)) : '' }
  const hello = parseClientHello({ ...proofBound, signature: signBytes(request.identityPrivateKey, helloSignatureBytes(proofBound)) })
  let privateKey: KeyObject | null = ephemeral.privateKey
  return Object.freeze({
    hello,
    complete(wire: unknown): EncryptedChannel {
      const capturedKey = privateKey
      privateKey = null
      if (capturedKey === null) throw new Error('Phone handshake already consumed')
      return completePhoneHandshake({ hello, ephemeralPrivateKey: capturedKey, wire, channelBudget })
    },
    close(): void { privateKey = null },
  })
}

function completePhoneHandshake(request: {
  readonly hello: ClientHello
  readonly ephemeralPrivateKey: KeyObject
  readonly wire: unknown
  readonly channelBudget: ChannelBudget
}): EncryptedChannel {
  const { hello, ephemeralPrivateKey, wire, channelBudget } = request
  const welcome = parsePcWelcome(wire)
  if (welcome.channelId !== hello.channelId
    || !verifyBytes(hello.pcIdentityKey, welcomeSignatureBytes(hello, welcome), welcome.signature)) {
    throw new Error('PC welcome signature or channel mismatch')
  }
  if (hello.authorization.kind === 'grant' && (hello.authorization.grantId !== welcome.grantId
    || hello.authorization.generation !== welcome.generation)) throw new Error('PC welcome grant mismatch')
  return channelFromHandshake({ role: 'phone', privateKey: ephemeralPrivateKey, hello, welcome, channelBudget })
}

/**
 * Verify phone identity possession and intended PC/origin before consulting PC authorization storage.
 * @param request - Untrusted hello plus caller-pinned PC identity and canonical origin.
 * @returns Signed validated hello; this is not an authorization or verified pairing secret.
 */
export function verifyClientHello(request: {
  readonly wire: unknown
  readonly pcIdentityKey: PublicKeySpki
  readonly httpsOrigin: HttpsOrigin
}): ClientHello {
  const hello = parseClientHello(request.wire)
  if (hello.pcIdentityKey !== request.pcIdentityKey || hello.httpsOrigin !== request.httpsOrigin) {
    throw new Error('Hello targets a different PC identity or HTTPS origin')
  }
  if (!verifyBytes(hello.phoneIdentityKey, helloSignatureBytes(hello), hello.signature)) throw new Error('Invalid phone hello signature')
  return hello
}

function verifyAuthorization(hello: ClientHello, authorization: AuthorizedHandshake): void {
  if (authorization.phoneIdentityKey !== hello.phoneIdentityKey || authorization.kind !== hello.authorization.kind) {
    throw new Error('Authorization decision does not match hello identity or kind')
  }
  parseId<GrantId>(authorization.grantId)
  parseGeneration(authorization.generation)
  if (hello.authorization.kind === 'grant') {
    if (authorization.grantId !== hello.authorization.grantId || authorization.generation !== hello.authorization.generation) {
      throw new Error('Authorization grant differs from requested grant')
    }
    return
  }
  if (authorization.kind !== 'invitation' || authorization.invitationId !== hello.authorization.invitationId
    || !timingSafeEqual(pairingProof(authorization.pairingSecret, hello), decodeBase64Url(hello.pairingProof, 32))) {
    throw new Error('Invalid pairing authorization or proof')
  }
}

/**
 * Authenticate the hello, enforce the explicit PC-owned decision, and generate a fresh signed welcome.
 * @param request - Wire hello, PC identity/origin, and externally resolved authorization for this phone.
 * @returns Signed welcome and unconfirmed encrypted channel; caller commits grant/invitation consumption atomically.
 */
export function acceptClientHello(request: {
  readonly hello: unknown
  readonly identityPrivateKey: KeyObject
  readonly httpsOrigin: HttpsOrigin
  readonly authorization: AuthorizedHandshake
  readonly channelBudget: ChannelBudget
}): { readonly hello: ClientHello; readonly welcome: PcWelcome; readonly channel: EncryptedChannel } {
  const channelBudget = parseChannelBudget(request.channelBudget)
  const hello = verifyClientHello({
    wire: request.hello, pcIdentityKey: exportPublicKey(request.identityPrivateKey), httpsOrigin: request.httpsOrigin,
  })
  verifyAuthorization(hello, request.authorization)
  const ephemeral = generateP256KeyPair()
  const unsigned: UnsignedPcWelcome = {
    v: 1, type: 'welcome', suite: SUITE, role: 'pc', channelId: hello.channelId,
    nonce: encodeBase64Url(randomBytes(32)), ephemeralKey: exportPublicKey(ephemeral.publicKey),
    grantId: request.authorization.grantId, generation: request.authorization.generation,
  }
  const welcome = parsePcWelcome({ ...unsigned, signature: signBytes(request.identityPrivateKey, welcomeSignatureBytes(hello, unsigned)) })
  return { hello, welcome, channel: channelFromHandshake({ role: 'pc', privateKey: ephemeral.privateKey, hello, welcome, channelBudget }) }
}

function channelFromHandshake(request: {
  readonly role: 'phone' | 'pc'
  readonly privateKey: KeyObject
  readonly hello: ClientHello
  readonly welcome: PcWelcome
  readonly channelBudget: ChannelBudget
}): EncryptedChannel {
  const peerKey = request.role === 'phone' ? request.welcome.ephemeralKey : request.hello.ephemeralKey
  const sharedSecret = diffieHellman({ privateKey: request.privateKey, publicKey: importPublicKey(peerKey) })
  try {
    return createChannel({ ...request, sharedSecret })
  } finally {
    sharedSecret.fill(0)
  }
}
