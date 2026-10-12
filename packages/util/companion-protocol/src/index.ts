/** Node-native companion encryption and relay key-possession primitives; no transport or trust storage. */
export type * from './types.ts'
export {
  canonicalBytes, counterBytes, decodeBase64Url, decodeCounter, encodeBase64Url, encodeCounter,
  exactRecord, KEY_USE_LIMIT, MAX_APPLICATION_BYTES, MAX_NORMALIZED_RELAY_FRAME_BYTES, parseGeneration, parseHttpsOrigin, parseId,
} from './bytes.ts'
export {
  decodeSignature, derivePcId, exportPublicKey, generateP256KeyPair, importPublicKey, parsePublicKey,
  signBytes, verifyBytes,
} from './keys.ts'
export {
  createRelayChallenge, parseRelayChallenge, relayChallengeBytes, signRelayChallenge, verifyRelayChallenge,
} from './relay-auth.ts'
export { parseClientHello, parseEncryptedFrame, parsePcWelcome, SUITE } from './wire.ts'
export {
  deriveDirectionMaterial, frameAdditionalData, frameNonce, handshakeTranscriptHash, helloSignatureBytes,
  signedHelloBytes, unsignedHelloBytes, welcomeSignatureBytes,
} from './transcripts.ts'
export type { DirectionMaterial } from './transcripts.ts'
export { acceptClientHello, createPhoneHandshake, verifyClientHello } from './handshake.ts'
export type { AuthorizedHandshake, PhoneAuthorization, PhoneHandshake, PhoneHandshakeRequest } from './handshake.ts'
export type { ChannelReceive, EncryptedChannel, FrameSender } from './channel.ts'
export { parseChannelBudget } from './channel-budget.ts'
export type { ChannelBudget } from './channel-budget.ts'
export { encodePairingInvitation, parsePairingInvitation } from './pairing.ts'
export type { PairingInvitation } from './pairing.ts'
export type * from './application-types.ts'
export {
  encodeApplicationRequest, encodeApplicationResult, MAX_MOBILE_JSON_BYTES,
  parseApplicationBudget, parseApplicationRequest, parseApplicationResult,
} from './application.ts'
