/** Frozen ordered authenticated transcripts; see the README wire reference for Java encoding. */
import { createHash, hkdfSync } from 'node:crypto'
import { canonicalBytes, counterBytes, decodeBase64Url } from './bytes.ts'
import { decodeSignature } from './keys.ts'
import type { ClientHello, Direction, EncryptedFrame, PcWelcome, UnsignedClientHello, UnsignedPcWelcome } from './types.ts'

/**
 * Encode every unsigned hello field, including its authorization reference.
 * @param hello - Validated hello fields.
 * @returns Canonical HMAC input; raw binary fields are decoded before length prefixing.
 */
export function unsignedHelloBytes(hello: UnsignedClientHello): Buffer {
  const authorization = hello.authorization.kind === 'grant'
    ? ['grant', hello.authorization.grantId, String(hello.authorization.generation)]
    : ['invitation', hello.authorization.invitationId]
  return canonicalBytes('dsh-companion/hello/v1', [
    '1', hello.suite, hello.role, hello.httpsOrigin, hello.channelId,
    decodeBase64Url(hello.phoneIdentityKey, 91), decodeBase64Url(hello.pcIdentityKey, 91),
    decodeBase64Url(hello.nonce, 32), decodeBase64Url(hello.ephemeralKey, 91), ...authorization,
  ])
}

/**
 * Bind the identity signature to the complete pairing proof or empty grant proof.
 * @param hello - Validated unsigned hello plus proof.
 * @returns Canonical phone signing input.
 */
export function helloSignatureBytes(hello: UnsignedClientHello & { readonly pairingProof: string }): Buffer {
  return canonicalBytes('dsh-companion/hello-signature/v1', [
    unsignedHelloBytes(hello), decodeBase64Url(hello.pairingProof, hello.authorization.kind === 'invitation' ? 32 : 0),
  ])
}

/**
 * Include canonical DER phone signature in the PC's signed transcript.
 * @param hello - Validated signed phone hello.
 * @returns Complete canonical signed hello bytes.
 */
export function signedHelloBytes(hello: ClientHello): Buffer {
  return canonicalBytes('dsh-companion/signed-hello/v1', [helloSignatureBytes(hello), decodeSignature(hello.signature)])
}

/**
 * Bind the PC identity signature to the entire hello and all welcome fields.
 * @param hello - Validated signed hello.
 * @param welcome - Validated unsigned welcome.
 * @returns Canonical PC signing input.
 */
export function welcomeSignatureBytes(hello: ClientHello, welcome: UnsignedPcWelcome): Buffer {
  return canonicalBytes('dsh-companion/welcome-signature/v1', [
    signedHelloBytes(hello), '1', welcome.suite, welcome.role, welcome.channelId,
    decodeBase64Url(welcome.nonce, 32), decodeBase64Url(welcome.ephemeralKey, 91),
    welcome.grantId, String(welcome.generation),
  ])
}

/**
 * Hash both complete signed handshake messages.
 * @param hello - Validated signed hello.
 * @param welcome - Validated signed welcome.
 * @returns SHA-256 transcript hash used by HKDF and encrypted confirmation.
 */
export function handshakeTranscriptHash(hello: ClientHello, welcome: PcWelcome): Buffer {
  return createHash('sha256').update(canonicalBytes('dsh-companion/transcript/v1', [
    welcomeSignatureBytes(hello, welcome), decodeSignature(welcome.signature),
  ])).digest()
}

/** One direction's key and key-specific nonce prefix; never expose on the wire. */
export interface DirectionMaterial {
  readonly key: Buffer
  readonly noncePrefix: Buffer
}

/**
 * Derive independently labelled key and nonce-prefix outputs for a single direction.
 * @param sharedSecret - Raw P-256 ECDH x-coordinate, exactly 32 bytes.
 * @param handshake - Validated signed hello and welcome.
 * @param direction - Authenticated traffic direction.
 * @returns AES-256 key32 and key-specific nonce prefix4; caller owns erasure.
 */
export function deriveDirectionMaterial(
  sharedSecret: Uint8Array, handshake: { readonly hello: ClientHello; readonly welcome: PcWelcome }, direction: Direction,
): DirectionMaterial {
  if (sharedSecret.length !== 32) throw new Error('Expected P-256 ECDH secret32')
  const salt = createHash('sha256').update(canonicalBytes('dsh-companion/hkdf-salt/v1', [
    decodeBase64Url(handshake.hello.nonce, 32), decodeBase64Url(handshake.welcome.nonce, 32),
  ])).digest()
  const transcriptHash = handshakeTranscriptHash(handshake.hello, handshake.welcome)
  const derive = (label: string, length: number) => Buffer.from(hkdfSync('sha256', sharedSecret, salt,
    canonicalBytes('dsh-companion/hkdf-info/v1', [transcriptHash, direction, label]), length))
  return { key: derive('aes-256-gcm-key', 32), noncePrefix: derive('aes-256-gcm-nonce-prefix', 4) }
}

/**
 * Encode the complete routing/authorization metadata as AES-GCM AAD.
 * @param frame - Validated metadata; ciphertext and tag are not included.
 * @returns LP domain, version, direction, channel, grant, generation, raw counter8.
 */
export function frameAdditionalData(frame: Omit<EncryptedFrame, 'ciphertext' | 'tag'>): Buffer {
  return canonicalBytes('dsh-companion/frame-aad/v1', [
    '1', frame.direction, frame.channelId, frame.grantId, String(frame.generation),
    decodeBase64Url(frame.counter, 8),
  ])
}

/**
 * Construct the fixed 12-byte GCM nonce without random or truncated counters.
 * @param material - Key-specific direction material.
 * @param counter - Invocation counter.
 * @returns Prefix4 concatenated with uint64BE counter8.
 */
export function frameNonce(material: DirectionMaterial, counter: bigint): Buffer {
  return Buffer.concat([material.noncePrefix, counterBytes(counter)])
}
