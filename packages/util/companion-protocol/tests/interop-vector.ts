/** SOURCE generator for Java interoperability fixtures; no top-level execution or file writes. */
import { createCipheriv, createECDH, createHmac, createPrivateKey, diffieHellman } from 'node:crypto'
import type { KeyObject } from 'node:crypto'
import {
  canonicalBytes, deriveDirectionMaterial, derivePcId, encodeBase64Url, encodeCounter,
  exportPublicKey, frameAdditionalData, frameNonce, handshakeTranscriptHash, helloSignatureBytes,
  importPublicKey, parseHttpsOrigin, parseId, signBytes, SUITE, unsignedHelloBytes, welcomeSignatureBytes,
} from '../src/index.ts'
import type { ChannelId, ClientHello, EncryptedFrame, GrantId, InvitationId, PcWelcome, UnsignedClientHello, UnsignedPcWelcome } from '../src/index.ts'

function fixedPrivateKey(scalar: number): KeyObject {
  const privateBytes = Buffer.alloc(32)
  privateBytes[31] = scalar
  const ecdh = createECDH('prime256v1')
  ecdh.setPrivateKey(privateBytes)
  const point = ecdh.getPublicKey(undefined, 'uncompressed')
  return createPrivateKey({
    format: 'jwk', key: {
      kty: 'EC', crv: 'P-256', d: encodeBase64Url(privateBytes),
      x: encodeBase64Url(point.subarray(1, 33)), y: encodeBase64Url(point.subarray(33, 65)),
    },
  })
}

/** Complete generated fixture values; all private material here is public, test-only scalar input. */
export interface InteropVector {
  readonly privateScalarsHex: readonly string[]
  readonly pairingSecretHex: string
  readonly hello: ClientHello
  readonly welcome: PcWelcome
  readonly pcId: string
  readonly unsignedHelloHex: string
  readonly helloSignatureInputHex: string
  readonly welcomeSignatureInputHex: string
  readonly transcriptHashHex: string
  readonly sharedSecretHex: string
  readonly phoneToPcKeyHex: string
  readonly pcToPhoneKeyHex: string
  readonly phoneToPcNoncePrefixHex: string
  readonly pcToPhoneNoncePrefixHex: string
  readonly confirmationPlaintextHex: string
  readonly confirmationNonceHex: string
  readonly confirmationAadHex: string
  readonly confirmationFrame: EncryptedFrame
}

/**
 * Generate a fixture for independent Java JCA verification and key derivation.
 * @returns Fixture with fixed scalar/nonces/secret; DER ECDSA signatures are native randomized values.
 */
export function generateInteropVector(): InteropVector {
  const phoneIdentity = fixedPrivateKey(1)
  const pcIdentity = fixedPrivateKey(2)
  const phoneEphemeral = fixedPrivateKey(3)
  const pcEphemeral = fixedPrivateKey(4)
  const pairingSecret = Buffer.alloc(32, 0x55)
  const unsigned: UnsignedClientHello = {
    v: 1, type: 'hello', suite: SUITE, role: 'phone', httpsOrigin: parseHttpsOrigin('https://relay.example'),
    channelId: parseId<ChannelId>('vector-channel'), phoneIdentityKey: exportPublicKey(phoneIdentity),
    pcIdentityKey: exportPublicKey(pcIdentity), nonce: encodeBase64Url(Buffer.from(Array.from({ length: 32 }, (_, index) => index))),
    ephemeralKey: exportPublicKey(phoneEphemeral), authorization: { kind: 'invitation', invitationId: parseId<InvitationId>('vector-invitation') },
  }
  const proofBound = { ...unsigned, pairingProof: encodeBase64Url(createHmac('sha256', pairingSecret).update(unsignedHelloBytes(unsigned)).digest()) }
  const hello: ClientHello = { ...proofBound, signature: signBytes(phoneIdentity, helloSignatureBytes(proofBound)) }
  const unsignedWelcome: UnsignedPcWelcome = {
    v: 1, type: 'welcome', suite: SUITE, role: 'pc', channelId: hello.channelId,
    nonce: encodeBase64Url(Buffer.from(Array.from({ length: 32 }, (_, index) => index + 32))),
    ephemeralKey: exportPublicKey(pcEphemeral), grantId: parseId<GrantId>('vector-grant'), generation: 1,
  }
  const welcome: PcWelcome = { ...unsignedWelcome, signature: signBytes(pcIdentity, welcomeSignatureBytes(hello, unsignedWelcome)) }
  const sharedSecret = diffieHellman({ privateKey: phoneEphemeral, publicKey: importPublicKey(welcome.ephemeralKey) })
  const phoneMaterial = deriveDirectionMaterial(sharedSecret, { hello, welcome }, 'phone-to-pc')
  const pcMaterial = deriveDirectionMaterial(sharedSecret, { hello, welcome }, 'pc-to-phone')
  const transcriptHash = handshakeTranscriptHash(hello, welcome)
  const plaintext = Buffer.concat([Buffer.from([0]), canonicalBytes('dsh-companion/key-confirmation/v1', [transcriptHash, 'phone-to-pc'])])
  const metadata = {
    v: 1, type: 'encrypted', direction: 'phone-to-pc', channelId: hello.channelId,
    grantId: welcome.grantId, generation: welcome.generation, counter: encodeCounter(0n),
  } as const
  const nonce = frameNonce(phoneMaterial, 0n)
  const aad = frameAdditionalData(metadata)
  const cipher = createCipheriv('aes-256-gcm', phoneMaterial.key, nonce, { authTagLength: 16 })
  cipher.setAAD(aad)
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
  return {
    privateScalarsHex: [1, 2, 3, 4].map(scalar => scalar.toString(16).padStart(64, '0')),
    pairingSecretHex: pairingSecret.toString('hex'), hello, welcome, pcId: derivePcId(hello.pcIdentityKey),
    unsignedHelloHex: unsignedHelloBytes(hello).toString('hex'), helloSignatureInputHex: helloSignatureBytes(hello).toString('hex'),
    welcomeSignatureInputHex: welcomeSignatureBytes(hello, welcome).toString('hex'), transcriptHashHex: transcriptHash.toString('hex'),
    sharedSecretHex: sharedSecret.toString('hex'), phoneToPcKeyHex: phoneMaterial.key.toString('hex'), pcToPhoneKeyHex: pcMaterial.key.toString('hex'),
    phoneToPcNoncePrefixHex: phoneMaterial.noncePrefix.toString('hex'), pcToPhoneNoncePrefixHex: pcMaterial.noncePrefix.toString('hex'),
    confirmationPlaintextHex: plaintext.toString('hex'), confirmationNonceHex: nonce.toString('hex'), confirmationAadHex: aad.toString('hex'),
    confirmationFrame: { ...metadata, ciphertext: encodeBase64Url(ciphertext), tag: encodeBase64Url(cipher.getAuthTag()) },
  }
}
