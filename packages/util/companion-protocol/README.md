---
description: "Authenticated PC/phone channels and fresh relay key-possession proofs, with a frozen Java-compatible binary wire reference."
kind: "package-library"
---

# dsh-companion-protocol

English | [中文](README.zh.md)

## Summary

Callers can authenticate a PC/phone handshake, exchange confirmed encrypted bytes, and prove identity-key possession to a relay. Node native crypto supplies P-256, SHA-256, HMAC, HKDF, and AES-GCM without a third-party cryptographic dependency. The wire reference defines the bytes an Android Java implementation must reproduce. Callers own pairing, grants, identity storage, transport, and every application authorization decision.

## Table of Contents

- [Use this package](#use-this-package)
- [Wire reference](#wire-reference)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

This is a Node-only library dependency, not a profile, Cordis plugin, transport, relay, or authorization service. Import the [entry module](src/index.ts); the [handshake APIs](src/handshake.ts) return an unconfirmed channel, and the [relay APIs](src/relay-auth.ts) prove key possession only.

The phone uses `createPhoneHandshake` with a pinned PC identity and validated origin. The PC uses `verifyClientHello` before consulting its own invitation/grant storage, then passes the matching explicit decision to `acceptClientHello`. The phone consumes its attempt once with `complete(welcome)`. Every attempt creates fresh nonces and ephemeral keys; reconnect never resumes keys or counters.

Both peers call `sendConfirmation` before sending application bytes. `receive` returns `kind: 'confirmation'` without dispatchable plaintext until mutual confirmation; only `kind: 'application'` carries application bytes. One queue serializes encryption, local transport-write settlement, and decryption. A transport callback must settle without awaiting peer acknowledgement or calling this same channel, otherwise it can deadlock the queue. Do not mutate queued wire objects; outgoing plaintext is copied before queueing. Callers bound queue depth and raw JSON size before parsing.

The PC must atomically reserve/consume a live invitation, verify its intended PC/origin and expiry, validate the pairing secret, assign/persist a grant, and prevent concurrent duplicate issuance before treating the channel as authorized. For grant reconnects, the PC checks the phone identity, current generation, permissions, expiry, and revocation. The library verifies that the caller's decision matches the signed reference; it never creates an authorization decision. The caller rechecks current authorization before each application dispatch and closes revoked channels. The caller validates any invitation receipt and handles receipt omission; receipt presence or absence is not a library trust decision.

A relay stores each challenge against the exact pending socket generation, bounds its lifetime, and consumes it atomically once. It verifies a proof against that stored challenge, never against a challenge supplied by the prover. A signing client checks the expected role, canonical origin, target PC and socket generation before signing. Neither a valid relay proof nor routing to a PC authorizes pairing or operations.

-----

<a id="wire-reference"></a>
## Wire reference

This section freezes version-one wire fields, order, encoding, and cryptographic inputs. JSON object property order is irrelevant; authenticated binary field order is not. Parsers reject omitted/extra fields, other versions/suites/roles, and noncanonical binary encodings. Callers decode JSON once and reject oversized raw messages before these parsers.

### Primitive encoding

`LP(x)` is `uint32BE(byteLength(x)) || x`, without a terminator. `C(domain; fields...)` is `LP(UTF8(domain)) || LP(field1) || ...`. Ordinary textual fields use exact UTF-8. A decimal field uses shortest unsigned ASCII decimal without leading zeros. Raw fields below use decoded bytes, not base64url text. Nested transcripts are one raw field, including all their own prefixes. No JSON serialization, whitespace, sorting, Unicode normalization, or delimiter joining enters an authenticated transcript.

All binary JSON fields use unpadded canonical base64url with alphabet `A-Z a-z 0-9 _ -`, zero unused trailing bits, and no whitespace. Identity and ephemeral public keys are exactly 91-byte canonical DER SPKI for `id-ecPublicKey` and named curve `prime256v1`/`secp256r1`, with an uncompressed point. Their fixed 27-byte prefix is `3059301306072a8648ce3d020106082a8648ce3d03010703420004`. Native key import validates the point; re-export must match every byte. PEM, private keys, explicit parameters, other curves, compressed points, malformed points, and trailing bytes are rejected. Both identity signatures use SHA-256 with ECDSA and canonical ASN.1 DER `(r,s)`; scalars must lie in `[1,n-1]`. Both high-S and low-S signatures are accepted; IEEE-P1363 is not. Node default DER signatures match Java JCA `SHA256withECDSA`, not `SHA256withECDSAinP1363Format`.

`pcId = base64url(SHA256(C('dsh-companion/pc-id/v1'; rawIdentitySPKI)))`. Opaque channel/grant/invitation/socket identifiers match `[A-Za-z0-9_-]{1,128}` and have distinct `dsh-brand` types. A PC id additionally decodes to exactly 32 bytes. `generation` is a JSON integer in `[1,4294967295]`; authenticated generation fields are decimal text. `httpsOrigin` must equal `new URL(text).origin` exactly and use HTTPS, with no credentials, path, trailing slash, query, or fragment. Canonical spelling does not establish origin ownership or reachability.

### Exact JSON fields

Each row lists the complete field set in presentation order; values marked binary use the primitive encoding above.

| Message | Fields |
|---|---|
| Phone hello | `v:1`, `type:'hello'`, `suite:'P256-SHA256-HKDF-A256GCM'`, `role:'phone'`, `httpsOrigin`, `channelId`, `phoneIdentityKey` (SPKI), `pcIdentityKey` (SPKI), `nonce` (32 bytes), `ephemeralKey` (SPKI), `authorization`, `pairingProof`, `signature` (DER). |
| Grant authorization | `kind:'grant'`, `grantId`, `generation`. `pairingProof` is the empty string. |
| Invitation authorization | `kind:'invitation'`, `invitationId`. `pairingProof` is HMAC-SHA256, 32 bytes. |
| PC welcome | `v:1`, `type:'welcome'`, the fixed `suite`, `role:'pc'`, `channelId`, `nonce` (fresh 32 bytes), `ephemeralKey` (fresh SPKI), `grantId`, `generation`, `signature` (DER). |
| Encrypted frame | `v:1`, `type:'encrypted'`, `direction`, `channelId`, `grantId`, `generation`, `counter` (8 bytes), `ciphertext`, `tag` (16 bytes). |
| Relay challenge | `v:1`, `type:'relay-challenge'`, `role:'pc'` or `'phone'`, `httpsOrigin`, `identityKey` (SPKI), `targetPcId` (32 bytes), `socketGeneration`, `challenge` (fresh 32 bytes). |
| Relay proof | `v:1`, `type:'relay-proof'`, `signature` (DER). |

### Handshake transcripts

All domain strings below are exact ASCII. `V` is UTF-8 `1`; `S` is UTF-8 `P256-SHA256-HKDF-A256GCM`. The domains and validated fixed fields bind message type even where JSON `type` is not a separate field.

| Name | Exact bytes |
|---|---|
| `U` (unsigned hello) | `C('dsh-companion/hello/v1'; V, S, 'phone', httpsOrigin, channelId, rawPhoneIdentitySPKI, rawPcIdentitySPKI, rawPhoneNonce32, rawPhoneEphemeralSPKI, authorizationFields...)`. |
| Grant authorization fields | `'grant', grantId, decimal(generation)`. |
| Invitation authorization fields | `'invitation', invitationId`. |
| Pairing proof `P` | `HMAC-SHA256(secret32, U)` for invitations; empty bytes for grants. The secret is never transmitted. |
| Phone signing input `H` | `C('dsh-companion/hello-signature/v1'; U, P)`. |
| Signed hello `HS` | `C('dsh-companion/signed-hello/v1'; H, rawPhoneSignatureDER)`. |
| PC signing input `W` | `C('dsh-companion/welcome-signature/v1'; HS, V, S, 'pc', channelId, rawPcNonce32, rawPcEphemeralSPKI, grantId, decimal(generation))`. |
| Transcript hash `T` | `SHA256(C('dsh-companion/transcript/v1'; W, rawPcSignatureDER))`. |

The phone signature binds the pairing proof and every unsigned hello field. The PC signature binds both identity keys, authorization reference, phone nonce/ephemeral/signature/proof, and every welcome field. The phone verifies the pinned PC key and exact hello tuple, including the granted id/generation on grant reconnects. A failed or successful welcome completion consumes the pending phone attempt; `close()` also consumes it. Invitation grants in the signed welcome are PC-assigned, not supplied by the phone.

### ECDH and HKDF

ECDH uses the fresh P-256 ephemeral keypair and the peer's validated SPKI. Its input key material `Z` is the raw 32-byte ECDH shared x-coordinate, including leading zeros. Identity private keys are not ECDH inputs. `salt = SHA256(C('dsh-companion/hkdf-salt/v1'; rawPhoneNonce32, rawPcNonce32))`.

For each direction `D`, exactly `phone-to-pc` or `pc-to-phone`, derive two independent RFC 5869 HKDF-SHA256 outputs with `IKM=Z` and this salt: key32 uses `info=C('dsh-companion/hkdf-info/v1'; T, D, 'aes-256-gcm-key')`, `L=32`; prefix4 uses `info=C('dsh-companion/hkdf-info/v1'; T, D, 'aes-256-gcm-nonce-prefix')`, `L=4`. Java may implement RFC 5869 with JCA `HmacSHA256`; no JSON bytes enter either call. Never share keys between directions or reuse this handshake material on reconnect.

### AES-GCM, counters, and confirmation

Each direction starts counter `0`. Wire counters are exactly eight unsigned big-endian bytes encoded as base64url, never JSON numbers or decimal strings. Zero is `AAAAAAAAAAA`; uint64 maximum is `__________8`. The fixed per-direction key-use limit is 1,048,576 invocations, including confirmation: valid invocation counters are `[0,1048575]`. No in-channel rekey, counter reset, or resume exists; exhaustion is terminal and requires a fresh handshake. uint64 is the encoding, not permission to exceed the key-use limit.

`nonce12 = keySpecificPrefix4 || uint64BE(counter)`. `AAD = C('dsh-companion/frame-aad/v1'; V, D, channelId, grantId, decimal(generation), rawCounter8)`. AES-256-GCM encrypts with a full 16-byte authentication tag, separated into the JSON `tag` field; `ciphertext` contains only encrypted payload bytes. A first payload is `0x00 || C('dsh-companion/key-confirmation/v1'; T, D)`. Every later application payload is `0x01 || applicationBytes`; application bytes may be empty and are limited to 65,536 bytes. The ciphertext parser permits at most 65,537 decoded bytes, including the tag byte but excluding the GCM tag.

The receiver requires its exact direction, channel, grant, generation, and next counter. It verifies GCM before classifying any payload or advancing the counter. The first received payload must be that direction's exact confirmation. Later payloads require completed local confirmation and the application tag. The sender advances only after its local transport write settles successfully. A failed phone welcome completion consumes its attempt; the PC caller must terminate a rejected hello attempt. For an established channel, any parse, GCM, counter/order, payload/confirmation, oversize-send, or transport-send failure closes it; no retry on that key or recovery past a rejected frame is permitted. Closing best-effort erases owned symmetric buffers and rejects queued operations after the current local write settles; the caller must close and await its owned transport separately. JavaScript cannot guarantee complete private-key or allocator-memory erasure.

### Relay authentication

`R = C('dsh-companion/relay-proof/v1'; V, role, httpsOrigin, rawIdentitySPKI, rawTargetPcId32, socketGeneration, rawChallenge32)`. The proof signs `R` with DER `SHA256withECDSA`. The PC role additionally requires `derivePcId(identityKey) == targetPcId`. Freshness depends on a new random challenge per socket authentication attempt and the relay's one-time pending-challenge storage; signature verification alone is stateless and does not prevent reusing a stored challenge. Relay authentication keys and channel identity keys use the same canonical public encoding, not the same transcript domain.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

[Canonical bytes](src/bytes.ts), [key validation](src/keys.ts), and [transcripts](src/transcripts.ts) define the interoperable cryptographic inputs. [Wire parsing](src/wire.ts) validates untrusted decoded JSON. [Handshakes](src/handshake.ts) check proof possession against an explicit caller-owned authorization decision, then derive an unconfirmed [channel](src/channel.ts). Transport, application encoding, persistence, invitation consumption and live grant checks remain outside these modules.

[The interoperability generator source](tests/interop-vector.ts) returns fixed test scalars 1–4, nonce bytes 0–31/32–63, secret byte `55` repeated 32 times, signed messages, ECDH output, directional keys/prefixes, transcript inputs, and an encrypted confirmation. ECDSA signatures are native randomized values, so each generated fixture must retain its complete signed messages and derived outputs. Java verification uses `KeyFactory.getInstance("EC")` with `X509EncodedKeySpec`, `Signature.getInstance("SHA256withECDSA")`, `KeyAgreement.getInstance("ECDH")`, `Mac.getInstance("HmacSHA256")`, and `Cipher.getInstance("AES/GCM/NoPadding")` with `GCMParameterSpec(128, nonce12)`; JCA's encrypted output appends the 16-byte tag. Fixed private scalars are public test inputs and must never become production identities.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read [branded identifiers](../brand/README.md) and [the repository architecture](../../../docs/architecture.md) for type ownership and composition. [Application messages](APPLICATION.md) have a separate reference from this cryptographic wire format.

-----

<a id="model-experience"></a>
## Model Experience

None, as wire validation and encryption add no model messages or tools; application consumers own every model-visible effect.

#### KV Cache effect

None directly; encrypting transport bytes does not modify a model request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Node-only implementation; Android/Java must independently reproduce this byte reference and validate interoperability fixtures.
- No transport, storage, replay cache, invitation receipt enforcement, pairing/grant authority, permission checks, revocation notifications, application operation dispatch, or acknowledgement semantics.
- Callers bound raw message size, handshake attempts, queue depth, timeouts, and authorization lifetime; the library fixes only cryptographic and decoded payload limits.
- Source tests and the interoperability generator require later execution. No compilation, test run, fixture generation, Java verification, or documentation gate execution is asserted here.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

Repository integration owns aggregate roots, path mappings, lockfile/dependency classification, application parsers/reexports, and bilingual pairing registration. Cryptographic source review does not replace executed cross-runtime verification.

</details>
