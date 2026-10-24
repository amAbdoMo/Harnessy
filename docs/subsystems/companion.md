# Native Companion

English | [中文](companion.zh.md)

The optional [Companion Host](../../packages/host/companion-host/README.md) provides Desktop-native pairing controls and authenticated phone access to Session reads and text submission. Management calls belong to Desktop main, not the renderer or Typert Remote API. Pairing links contain a single-use secret and must not enter renderer state, telemetry, or model context.

The [Host integration reference](../../packages/host/companion-host/INTEGRATION.md) owns native control, authorization, credential storage, and teardown requirements. The [shared protocol reference](../../packages/util/companion-protocol/README.md) owns wire encoding and cryptography; the [relay reference](../../packages/host/companion-relay/README.md) owns transport routing and admission limits. Source and keyless tests do not establish physical Android interoperability or native Windows security acceptance.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxcompanionhost--companionhost"></a>

### `ctx.companionHost` — `CompanionHost`

No Typert Remote decorations: this API is callable only by trusted same-process native controls.

```ts cordis-catalog
/**
 * Report public management metadata without the one-time invitation secret or private signing key.
 * @returns Fresh native-management status; the renderer receives only availability, connection and count.
 */
describe(): CompanionStatus

/**
 * Create one ephemeral invitation; only Desktop main may receive its fragment secret for clipboard use.
 * @returns A one-time harnessy://pair link; no existing PC launch token or durable identity secret.
 */
createInvitation(): Promise<PrivateInvitation>

/**
 * Abort candidate authority immediately, then remove any grant committed by its in-flight approval.
 * @returns Provider commit and teardown; failures disable this Host incarnation.
 */
cancelInvitation(): Promise<void>

/**
 * Enroll exactly the candidate whose locally displayed fingerprint the operator confirmed.
 * @param candidateId - Current main-owned candidate, not a phone or relay-selected grant id.
 * @param confirmFingerprint - Exact SHA-256 hex shown by describe().
 * @returns Committed public device; failed welcome delivery does not undo enrollment or imply a safe retry.
 */
approveCandidate(candidateId: CandidateId, confirmFingerprint: string): Promise<PairedDevice>

/**
 * Withdraw the channel authorization capability synchronously, then remove the durable current row.
 * @param grantId - PC-issued current record identifier.
 * @returns Completion after provider commit and affected application teardown; any failure disables this Host incarnation.
 */
revokeGrant(grantId: GrantId): Promise<void>

/**
 * Withdraw current channels immediately and commit explicit per-phone chat management consent without re-pairing.
 * @param command - Native-confirmed grant id, generation, fingerprint and permission;
 *   all three identifiers are rechecked under the update lock.
 * @returns Provider commit and channel teardown; any failure disables this Host until explicit recovery.
 */
setSessionManagement(command: Extract<CompanionControlCommand, { readonly kind: 'setSessionManagement' }>): Promise<void>

/**
 * Commit independent native-confirmed model-selection consent without changing chat-management permission or pairing.
 * @param command - Current grant identity, generation, full fingerprint, and explicit permission choice.
 * @returns Credential commit and retired-channel teardown; failure withdraws this Host incarnation.
 */
setModelSelection(command: Extract<CompanionControlCommand, { readonly kind: 'setModelSelection' }>): Promise<void>

/**
 * Commit independent consent for phone-visible tool locations and fixed summaries, including past events.
 * @param command - Current grant identity, generation, full fingerprint and explicit permission choice.
 * @returns Credential commit and affected channel retirement; other permissions and pairing remain unchanged.
 */
setToolDetails(command: Extract<CompanionControlCommand, { readonly kind: 'setToolDetails' }>): Promise<void>

/**
 * Commit native-confirmed permission to open existing ordinary chats without desktop tab navigation.
 * @param command - Current grant identity, generation, full fingerprint and explicit activation decision.
 * @returns Credential commit and channel retirement; pairing and all other capabilities are preserved.
 */
setSessionActivation(command: Extract<CompanionControlCommand, { readonly kind: 'setSessionActivation' }>): Promise<void>
```

Source: [`packages/host/companion-host/src/index.ts`](../../packages/host/companion-host/src/index.ts)
<!-- END GENERATED cordis-surface -->
