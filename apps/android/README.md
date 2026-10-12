---
description: "Native foreground Android companion assembly, pairing and delivery safety, and source-only verification limits."
---

# Harnessy Android companion

English | [中文](<README.zh.md>)

## Summary

The native Java companion source assembles invitation pairing, existing-session browsing, approved literal-text history/progress, and explicit queued text follow-ups to a running PC. Agents and session storage remain PC-owned. This handoff is source-only: no APK, successful compilation, test result, device execution, or live connectivity is claimed.

## Table of Contents

- [Application assembly](#application-assembly)
- [Pairing and storage](#pairing-and-storage)
- [Reads and delivery](#reads-and-delivery)
- [Limits and verification](#limits-and-verification)
- [Dev Note](#dev-note)

<a id="application-assembly"></a>
## Application assembly

[MainActivity](<app/src/main/java/io/harnessy/companion/MainActivity.java>) is the exported native launcher and single-task invitation entry declared in the [manifest](<app/src/main/AndroidManifest.xml>). It renders [CompanionView](<app/src/main/java/io/harnessy/companion/presentation/CompanionView.java>) or [PairingView](<app/src/main/java/io/harnessy/companion/presentation/PairingView.java>) on the main thread, requests system/IME insets, and owns native forget/review confirmations. EN/ZH resources, light/dark tokens, accessible native controls, and the existing wide-screen layout are retained. No WebView or remote JavaScript is involved.

[CompanionController](<app/src/main/java/io/harnessy/companion/CompanionController.java>) owns one foreground epoch and one current attempt. `onStart` loads and revalidates stored metadata and connects automatically; `onStop` invalidates immediately, cancels controller deadlines/reconnects/subscriptions, closes transport, and discards invitations. Retired callbacks cannot publish or send. A new attempt waits for the old transport’s `quiescence()`. Configuration recreation retains the controller’s bounded RAM draft/selection, not network activity; process recreation restores no task text or draft. There is no background service, offline queue, push notification, or cloud-account promise.

[CompanionApplication](<app/src/main/java/io/harnessy/companion/CompanionApplication.java>) shares only one bounded serialized IO adapter. [AndroidCompanionPlatform](<app/src/main/java/io/harnessy/companion/AndroidCompanionPlatform.java>) performs preference/keystore access off the UI thread, serializes signing through that same owner, and also awaits transport retirement across Activity instances. [CompanionPlatform](<app/src/main/java/io/harnessy/companion/CompanionPlatform.java>) exposes only external platform operations for controller regression fixtures.

Every reconnect constructs a fresh [PhoneTransport](<app/src/main/java/io/harnessy/companion/transport/PhoneTransport.java>) with the saved phone alias, pinned canonical HTTPS origin/PC key, and authenticated grant generation. Protocol nonce, ephemeral ECDH key, channel ID, and counters are fresh. Transport itself never reconnects. The controller retries at a configured minimum interval for as long as it remains foreground; it has no finite total attempt limit. Missing keys and invalid storage stop automatic attempts and require explicit repair. Online means mutual encrypted key confirmation, not inbox admission or completed work.

<a id="pairing-and-storage"></a>
## Pairing and storage

Opening a link imports but never enrolls automatically. The Activity accepts only the `harnessy` scheme and `pair` host, clears incoming Intent data/extras/ClipData immediately after import, and never navigates any URL. [Invitation.parse](<app/src/main/java/io/harnessy/companion/protocol/Invitation.java>) requires exact canonical `harnessy://pair#` text, version/field/key/origin/PC-ID validation, and unexpired invitation data. Cancel, expiry, background, and authenticated success drop invitation/link/secret references; Java/provider buffer erasure remains best effort.

Explicit Pair creates a new per-enrollment alias through [PhoneIdentity.createForPairing](<app/src/main/java/io/harnessy/companion/identity/PhoneIdentity.java>). The pairing view displays the full 64-character lowercase SHA-256 fingerprint of the phone’s public SPKI DER for comparison with the PC dialog. The signer uses `signTranscript(alias, bytes)`; it never exports the private key. An existing pairing must be explicitly forgotten before that same PC is enrolled again. Missing or invalid paired keys are never silently replaced.

Only authenticated `onConfirmed` grant ID/generation, pinned PC key/origin/derived PC ID, and the phone alias enter [PairingStore](<app/src/main/java/io/harnessy/companion/pairing/PairingStore.java>). The displayed PC name is a generic localized local label because the wire has no name. Stored metadata is revalidated against [Protocol](<app/src/main/java/io/harnessy/companion/protocol/Protocol.java>) before use. The UI exposes the first stored PC; it does not yet offer a saved-PC chooser, although the store retains up to 32 records.

[OperationStore](<app/src/main/java/io/harnessy/companion/pairing/OperationStore.java>) retains at most 32 minimal delivery fences and 32 public PC-ID/alias repair markers. A repair marker precedes enrollment persistence or local forget. A failed SharedPreferences `commit()` may change memory without confirmed disk durability: the controller stays fenced and retains the alias, rather than claiming rollback or deleting a potentially referenced key. A repair marker can identify an alias even when settled pairing metadata is absent. Corrupt/version-unknown documents are not reset automatically. Confirmed storage settlements survive foreground retirement and reconcile with fresh metadata before further storage mutations; clearing delivery uncertainty does not clear an independent pairing-repair blocker.

Forget is local, not PC revocation. The Activity warns before it fences/stops the owner, commits metadata removal, deletes only the exact phone alias after that commit succeeds, then clears the repair marker. A failed metadata commit retains the alias and fence. Preference/keystore operations are not a cross-store atomic transaction. Uncertainty fences survive forget; revocation or forgetting does not erase work already admitted on the PC. Check the original session before resetting corrupt application data.

<a id="reads-and-delivery"></a>
## Reads and delivery

The [application codec](<app/src/main/java/io/harnessy/companion/protocol/ApplicationCodec.java>) consumes validated immutable DTOs for only `listSessions`, `readHistory`, `watchProgress`, `cancelRead`, and `submitText`. Every request uses a fresh correlation ID. Pending reads and deadlines are bounded independently of mutations. Reconnect recreates only reads/subscriptions, retaining same-session text while refreshing authority. Watch acknowledgement establishes the live subscription before reading history; renewal cancels the previous subscription before repeating that sequence. Baselines merge with the bounded live window; an unknown watch/cancel outcome closes the attempt to prevent accumulating remote subscriptions.

Separate native load-more controls round-trip opaque listing/history cursors through their issuing operation. Progress cursors never become history cursors. Progress requires the exact subscription ID, selected session, and current epoch/attempt. Row IDs and sequences are deduplicated within the bounded, sequence-ordered retained text window. Literal `TextView` output contains no clickable links/scripts/raw tool arguments. Queued/running is a busy display status but still allows queued follow-ups; closed sessions deny the composer. No unsupported approval status is inferred from error codes.

Explicit Send requires a confirmed connection, an existing non-closed selected session, and no pending mutation/uncertainty fence. The controller freezes session/text/request/submission IDs and commits a minimal `{pcId, sessionId, submissionId}` fence before transport admission. No task text or resend payload is persisted. `ADMITTED_MAY_WRITE` is uncertain until an exact matching `submitted` result with `admission=inMemoryInbox`; that result acknowledges only a volatile PC inbox, never durability or task completion. The draft clears only after a confirmed fence-removal commit and only if it is unchanged.

Disconnect, timeout, or foreground retirement after possible admission retains `DELIVERY_UNKNOWN`; reconnect/process restart never resends. Failed pre-send fence commits prevent sending; failed fence-removal commits keep the composer blocked even if preference memory changed. The original session/submission IDs remain visible. The localized Review/discard action requires a native confirmation after the user checks the original session, commits removal of only the warning, and enables a new explicit Send without resending, cancelling, or erasing the previous task.

<a id="limits-and-verification"></a>
## Limits and verification

[XML budgets](<app/src/main/res/values/limits.xml>) explicitly supply [ControllerLimits](<app/src/main/java/io/harnessy/companion/ControllerLimits.java>) and [TransportLimits](<app/src/main/java/io/harnessy/companion/transport/TransportLimits.java>): reconnect minimum 5 s, reads 10 s, mutation ACK 15 s, read-only heartbeat 20 s, watch renewal 60 s, 8 pending reads, 64-row pages, 256 sessions, and 256 rows/256 KiB retained text. Heartbeat is bounded `listSessions(limit=1)`, not a new wire verb; native ping is disabled because the current broker rejects ping/pong and counts only application frames as activity. OkHttp allocates complete incoming text before listener retention checks; these budgets do not claim a preassembly memory cap.

The [Gradle declaration](<app/build.gradle>) remains AGP 8.7.3, compile/target SDK 35, minimum SDK 26, Java 8 source, JDK 17/Gradle 8.9 prerequisites, and OkHttp 4.12.0. [Wrapper properties](<gradle/wrapper/gradle-wrapper.properties>) pin only the distribution; genuine wrapper scripts/JAR/checksum, SDK/toolchain provisioning, signing, and deployment belong to the integration owner. The manifest disables cleartext and backup/device transfer; no credentials, invitation secrets, private keys, generated binaries, or new dependencies are supplied.

[ProtocolRegression](<app/src/test/java/io/harnessy/companion/protocol/ProtocolRegression.java>) resides under test sources, not the APK’s production sources. [ControllerRegression](<app/src/test/java/io/harnessy/companion/ControllerRegression.java>) adds source scenarios for lost ACK/stale epochs, quiescent rate-bounded reconnects, missing paired keys, preference failure fencing, opaque paging/correlation, running-session sends, draft ACK semantics, restart warnings, and enrollment/forget failures. Only external clock/network/keystore/preferences/executor operations are faked; controller/parser/models remain real. These standalone `main` regression entries are not JUnit-discovered and require a provisioned JVM runner; they were not compiled or executed here.

Runtime acceptance requires Android compilation/lint/manifest merging, Node interoperability and broker/PC connectivity, platform API 26/35 and actual keystore/preference failure behavior, foreground/configuration/process recreation, EN/ZH/light/dark/phone/tablet/landscape/large-font/TalkBack/IME presentation, backup exclusions, and focused unit/device/UI evidence. Source review and TypeScript/documentation checks do not establish those outcomes; APK construction, signing, deployment and device validation remain deferred.

<a id="dev-note"></a>
## Dev Note

None.
