---
description: "Native Android companion source, one-time PC approval, secure relay deployment prerequisites, and explicit delivery-unknown recovery."
---

# Cookbook: connect Android to Harnessy

## Summary

The native Android companion is designed to monitor existing PC sessions and queue text follow-up tasks through a built-in encrypted relay connection. Agents, tools and session storage remain on the running PC. The phone does not need Tailscale, a browser installation or a second Harnessy server on the PC.

**This delivery prepares source, not an installable APK or a live hosted relay.** Android compilation/signing, deployment at a real HTTPS origin and physical-device verification remain owner operations. Source changes do not activate a running Desktop app. Follow the [safe build workflow](HARNESSY-STAGING-DELIVERY.md#safe-builds) before building or activating Desktop changes.

## Table of Contents

- [Supported access](#supported-access)
- [Deployment and build prerequisites](#prerequisites)
- [Pair once](#pair)
- [Reconnect and delivery unknown](#recovery)
- [Remove phone access](#remove-access)
- [Acceptance checklist](#acceptance)

-----

<a id="supported-access"></a>
## Supported access

The first version supports existing ordinary sessions: list sessions, read approved text history, observe progress and submit a queued text follow-up. It does not create sessions, transfer attachments, answer tool approvals, expose terminals/files/settings, guarantee background notifications or retain an offline task queue. A running session can receive a queued follow-up; running status alone is not a reason to resend a task.

An approved phone can cause the existing PC Agent to execute tasks with that session's existing tools and permissions. This is task-submission authority, not remote tool-approval authority. Protect the phone and approve only its complete fingerprint. The relay receives routing identities, ciphertext sizes and timing, not session plaintext or the PC operator login token; Android, the PC and their application publishers remain trusted endpoints.

Keep the PC awake with Desktop running and Internet access available. Leaving the Android app disconnects its foreground transport; reopening it reconnects using the saved phone key and pinned PC identity. No PC router forwarding or public operator listener is required.

-----

<a id="prerequisites"></a>
## Deployment and build prerequisites

These are release/operator operations, not repeated end-user pairing steps:

1. Deploy the [standalone relay profile](packages/bundle/companion-relay/README.md) behind a same-host managed TLS proxy at an actual canonical HTTPS origin. Supply all validated relay budgets, preserve the public Host header, restrict the upstream to loopback and apply external HTTP/upgrade/traffic limits. The profile does not include agents, tools, an operator Gateway or session storage. No available hostname is supplied by this checkout.
2. Configure Desktop's launch environment with `DSH_DESKTOP_COMPANION_HTTPS_ORIGIN` and `DSH_DESKTOP_COMPANION_BUDGETS`, a complete JSON budget object matching [the PC schema](packages/host/companion-host/src/config.ts). With neither value, the feature is unavailable and creates no identity or socket. Partial or invalid configuration fails; changing the stored origin requires local retirement/reset and re-pairing. [PC integration](packages/host/companion-host/INTEGRATION.md) owns the private management and storage details.
3. Fully quit the active staging and installed Desktop applications before browser/Desktop builds. Compile and activate through [Desktop's documented workflow](apps/desktop/README.md), not a replacement Web server. The normal pre-push hook also invokes a Desktop welcome-UI build; it cannot run safely underneath an active staging app.
4. Build and sign [the Android project](apps/android/README.md) with its pinned toolchain and declared dependencies. Verify the signing certificate and install the resulting APK on the intended phone. Android tooling/dependency setup and APK signing have not been performed here.

The PC connector makes an outbound WSS connection. Do not configure the old `DSH_DESKTOP_REMOTE_URL`/`DSH_DESKTOP_LISTEN_PORT` operator-access pair as part of native companion setup. That optional legacy private-network feature grants broader operator access and is not the native companion's security model.

-----

<a id="pair"></a>
## Pair once

After the operator has deployed the relay, built both applications and completed acceptance:

1. In Desktop, open **Settings → General → Android phone companion → Open native phone settings**. Choose **Pair Android phone**. Main copies a short-lived invitation to the native clipboard; the renderer never receives its secret.
2. Paste the invitation into the Harnessy Android app and explicitly choose **Pair with this invitation**. Importing alone does not enroll. The app creates its own non-exportable AndroidKeyStore signing key and presents its complete phone fingerprint while waiting for PC approval. The invitation uses `harnessy://pair#` with a versioned fragment; it is not a website to visit.
3. On the PC, choose **Approve pairing request**. Compare the complete fingerprint with the one displayed on the phone, then explicitly approve that exact request. Possessing an invitation alone does not authorize session access.
4. Confirm the Android app connects and shows the same existing PC session. Keep the invitation private and clear clipboard history/sync copies after transfer. Expired or cancelled invitations require a new invitation, not disabling authentication.

The phone stores public pairing metadata and its private key remains in AndroidKeyStore. Reopening the foreground app reconnects without pasting the invitation again. Missing keys, corrupt pairing metadata or a changed PC identity require explicit repair/re-pairing; the app must not silently generate a replacement identity for an existing pairing.

-----

<a id="recovery"></a>
## Reconnect and delivery unknown

Reads and subscriptions can restart after reconnect with fresh channel keys and a current history baseline. Task submissions are never automatically retried, replayed from an offline queue or restored as queued work after process restart.

A matching `submitted` acknowledgement means **in-memory PC inbox admission**, not checkpoint durability, task execution or completion. If the connection, foreground owner or acknowledgement is lost after a possible write, delivery is unknown: the PC may already have admitted the task. Inspect the PC session and explicitly resolve the phone's uncertainty warning before deciding whether to send a new task. Missing visible history is not a durable receipt proving non-delivery.

A credential-source failure or failed grant withdrawal disables that PC Host's companion authority rather than re-authorizing from cached rows. Repair the source and restart its provider/Host before restoring access. Do not clear phone keys or disable identity/origin checks merely to resolve a connection failure.

-----

<a id="remove-access"></a>
## Remove phone access

On the PC, open native phone settings, choose **Paired phones**, identify the phone by its fingerprint and choose **Remove access**. Completion requires the provider commit and affected channel teardown. A failed or timed-out operation has an unconfirmed outcome; refresh the roster and repair any source failure rather than assuming removal was undone or succeeded.

Removal prevents new access and submissions not yet admitted. Already admitted PC work continues, and previously delivered data is not erased. Forgetting a pairing only on Android does not revoke the PC grant; remove access on the PC for a lost phone.

To disable the optional feature, fully quit Desktop, remove its two companion launch values and restart normally. Retire the old Host before any local identity reset. Copying a credential home clones its PC identity; the local kernel lock does not protect another copied home or another PC.

-----

<a id="acceptance"></a>
## Acceptance checklist

Before relying on the feature, verify these outcomes on the deployed relay and signed APK:

- The PC retains its existing sessions and ordinary local-only operator endpoint; unpaired phones cannot read or submit tasks.
- Invitation possession without exact native PC approval gains no session authority; expiry, cancellation, mismatched fingerprints and replayed/wrong-origin handshakes are denied.
- Node and Android agree on DER/SPKI, transcript/HKDF bytes, AES-GCM tags, direction bindings and fixed-width counters. Application messages are rejected before both encrypted confirmations.
- Cold history reads do not activate agents; tool arguments/results, reasoning and raw filesystem metadata are not exported by mobile projections.
- Mobile data away from home can connect to the deployed relay; reconnect refreshes reads without duplicating submissions or subscriptions.
- Lost acknowledgements and process restart retain an uncertainty fence without storing task text or automatically resending it.
- Revocation and credential-source failure prevent fresh authorization and final inbox admission; already admitted work continues.
- Multiple PC owners, slow readers, oversized frames, queue saturation and stale socket callbacks remain bounded and cannot retire unrelated phones.
- Foreground teardown joins owned resources; keyboard/insets, tablet layout, accessibility, backup exclusions and AndroidKeyStore behavior work on the supported Android versions.

These are deferred runtime/security acceptance operations, not results inferred from source compilation. No relay deployment, APK build/install, physical-device run or application restart is represented as completed.
