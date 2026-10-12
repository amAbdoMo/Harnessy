# Agent Note: Native Android relay authority

Status: implemented

English | [中文](2026-10-12-native-android-relay-authority.zh.md)

## Problem

A phone needs access to existing PC sessions away from home without installing a private-network client or administering a second tool-capable server. Browser operator credentials authorize substantially more than session inspection and queued text follow-ups. Network reachability and possession of an invitation do not establish the PC owner's consent.

## Decision

The native companion uses an outbound PC connection and a standalone ciphertext relay. The relay routes authenticated socket identities but does not grant session authority or receive session plaintext. PC-owned grants and the private Desktop ownership capability enforce the closed read/task operation set. Agents and persistence remain in the existing PC process.

Pairing uses an expiring invitation and explicit Main-owned approval of the complete phone fingerprint. The renderer receives only availability, connection state and paired count; neither approval identifiers nor invitation secrets pass through it. AndroidKeyStore-compatible P-256 identities and domain-separated signed transcripts bind the pinned PC key, relay origin and ephemeral ECDH exchange. Both encrypted confirmations precede application access.

Follow-ups preserve the existing session's tool authority without adding remote tool approvals. The final admission check runs synchronously immediately before inbox insertion. Its acknowledgement represents volatile inbox admission, so disconnects cannot justify automatic retries. Android persists only uncertainty identifiers and pairing-repair markers, not task text or an offline mutation queue.

Credential-source failure permanently withdraws that provider incarnation's companion authority because last-good cached reads cannot establish current authorization. Failed withdrawal persistence also disables the current companion incarnation rather than inventing a durable revocation. Kernel exclusion prevents a paused owner from losing the same-home identity lock; it does not protect copied credential homes.

## Alternatives considered

**Use private browser access as the native transport.** Its VPN setup and complete operator authority do not meet the install-and-pair-once, narrow-access requirement. The separate [private browser decision](2026-10-11-harnessy-android-companion.md) remains active for that optional compatibility feature.

**Start another PC Web process or expose the operator Gateway publicly.** Another process does not own the running agents and can contend on durable data. Publishing the broad Gateway also makes UI filtering an ineffective authorization mechanism.

**Retry after a lost acknowledgement or persist an offline task queue.** Admission can succeed before its receipt or checkpoint is lost. Automatic replay can duplicate work; explicit inspection and a new user decision preserve honest uncertainty.

## Consequences

The PC must remain awake and connected. Hosted TLS/proxy operation, Android provisioning/signing and device interoperability remain deployment responsibilities; source review and TypeScript checks do not establish runtime security. The [native setup and acceptance guide](../../../../HARNESSY-ANDROID-COMPANION.md) owns those operations.

The relay observes routing identities, sizes and timing. Clipboard synchronization can disclose invitations; Android, the PC and their publishers remain trusted endpoints. Grant removal prevents future authorization and admission but does not erase delivered data or cancel already-admitted PC work.

The private browser record is partially superseded only as the primary Android workflow. Its browser authentication, private-proxy rationale and broader operator semantics remain applicable, so it stays active and cross-linked rather than being rewritten or archived.
