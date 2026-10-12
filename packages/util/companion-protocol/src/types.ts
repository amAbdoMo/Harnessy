/** Wire-only types for the version-one companion and relay protocols. */
import type { Branded } from '@deepseek-ai/dsh-brand'

/** SHA-256 identifier of the canonical PC identity public key. */
export type PcId = Branded<'CompanionPcId'>
/** Caller-owned channel routing identifier. */
export type ChannelId = Branded<'CompanionChannelId'>
/** PC-owned authorization record identifier. */
export type GrantId = Branded<'CompanionGrantId'>
/** PC-owned single-use pairing invitation identifier. */
export type InvitationId = Branded<'CompanionInvitationId'>
/** Relay-owned connection incarnation identifier. */
export type SocketGeneration = Branded<'CompanionSocketGeneration'>
/** Canonical HTTPS origin with no trailing slash. */
export type HttpsOrigin = Branded<'CompanionHttpsOrigin'>
/** Canonical P-256 public SPKI DER encoded as unpadded base64url. */
export type PublicKeySpki = Branded<'CompanionPublicKeySpki'>
/** Canonical unpadded base64url encoding of eight unsigned big-endian bytes. */
export type Counter = Branded<'CompanionCounter'>
/** Endpoint identity role; neither role implies authorization. */
export type Role = 'pc' | 'phone'
/** Direction is authenticated independently of the routing transport. */
export type Direction = 'phone-to-pc' | 'pc-to-phone'
/** Hello authorization reference; a signature is not a grant. */
export type HelloAuthorization =
  | { readonly kind: 'grant'; readonly grantId: GrantId; readonly generation: number }
  | { readonly kind: 'invitation'; readonly invitationId: InvitationId }

/** Unsigned phone hello, with both intended endpoint identities bound. */
export interface UnsignedClientHello {
  readonly v: 1
  readonly type: 'hello'
  readonly suite: 'P256-SHA256-HKDF-A256GCM'
  readonly role: 'phone'
  readonly httpsOrigin: HttpsOrigin
  readonly channelId: ChannelId
  readonly phoneIdentityKey: PublicKeySpki
  readonly pcIdentityKey: PublicKeySpki
  readonly nonce: string
  readonly ephemeralKey: PublicKeySpki
  readonly authorization: HelloAuthorization
}

/** Signed hello; proof is empty for grant authorization and HMAC32 for pairing. */
export interface ClientHello extends UnsignedClientHello {
  readonly pairingProof: string
  readonly signature: string
}

/** PC response; its signature binds the complete signed hello and these fields. */
export interface UnsignedPcWelcome {
  readonly v: 1
  readonly type: 'welcome'
  readonly suite: 'P256-SHA256-HKDF-A256GCM'
  readonly role: 'pc'
  readonly channelId: ChannelId
  readonly nonce: string
  readonly ephemeralKey: PublicKeySpki
  readonly grantId: GrantId
  readonly generation: number
}

/** Signed PC response. */
export interface PcWelcome extends UnsignedPcWelcome {
  readonly signature: string
}

/** Strict JSON encrypted envelope; counters are never JSON numbers. */
export interface EncryptedFrame {
  readonly v: 1
  readonly type: 'encrypted'
  readonly direction: Direction
  readonly channelId: ChannelId
  readonly grantId: GrantId
  readonly generation: number
  readonly counter: Counter
  readonly ciphertext: string
  readonly tag: string
}

/** Fresh relay-issued challenge, scoped to exactly one pending socket. */
export interface RelayChallenge {
  readonly v: 1
  readonly type: 'relay-challenge'
  readonly role: Role
  readonly httpsOrigin: HttpsOrigin
  readonly identityKey: PublicKeySpki
  readonly targetPcId: PcId
  readonly socketGeneration: SocketGeneration
  readonly challenge: string
}

/** Proof of key possession, not authority to pair or execute operations. */
export interface RelayChallengeProof {
  readonly v: 1
  readonly type: 'relay-proof'
  readonly signature: string
}
