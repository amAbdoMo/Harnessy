---
description: "Desktop-owned native phone pairing and encrypted access to existing same-PC Sessions, with local approval and grant withdrawal."
kind: "package-reference"
---

# @deepseek-ai/dsh-companion-host

English | [中文](README.zh.md)

## Summary

Monitor ordinary PC chats, open eligible existing chats and queue follow-ups from a locally approved phone. Independent PC grants can enable chat management, opening existing chats, session-only model selection and restricted tool details. Pairing requires a one-time invitation and fingerprint approval; it grants none of those permissions. The phone cannot delete chats, approve tools, browse files, run arbitrary commands or call the operator API. Source preparation does not update installed applications.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

The integration owner mounts this default service in the Desktop Host composition after installing the private Desktop ownership capability; source API and wire details are in [Integration](INTEGRATION.md) ([中文](INTEGRATION.zh.md)).

### Configuration

An omitted `httpsOrigin` makes the optional feature unavailable without generating an identity or opening a socket. A present origin must be the actual canonical deployment HTTPS origin, with every field in `budgets` supplied explicitly. Blank origins, partial budgets, nonpositive limits, unsafe timer intervals, inconsistent byte limits, and changed stored origins fail at load. `maxFrameBytes` is at least 96 KiB, covering normalized relay envelopes before ws preassembly; active input saturation rejects the exact phone incarnation, not the shared PC socket. Reconnect backoff bursts continue until Host retirement without replaying mutations. No example hostname is generated or treated as a working relay.

| Field | Default | Meaning |
|---|---|---|
| `httpsOrigin` | Omitted: unavailable | Actual public HTTPS relay origin, pinned in the credential record. |
| `budgets` | Required with origin | Explicit admission, retention, connection and application limits from [the schema](src/config.ts), including `channel` cryptographic queue and write-time limits. |

### Read-only Workspace navigation

The opt-in `listSessions` navigation view mirrors PC Workspace membership and pins only for returned, visible ordinary Sessions. The first explicit membership in Workspace registry order supplies the Workspace ID, sanitized title and order; no membership yields `null`. The response contains neither folder paths/cwd nor an empty-Workspace inventory, and never infers membership from a Session title, ID or cwd. `pinOrder` is the global PC pin rank, not a per-Workspace rank. This view remains a read-only projection; separately authorized management commands can change PC pins. The granted Workspace catalog, unlike ordinary listings, includes registered empty Workspaces without paths. See [management permission and compatibility](../../../docs/upgrade-guide/v0.1.15/companion-chat-management/guide.md).

`updatedAt` matches Desktop recency: the later of Session creation and the cached latest durable human prompt, not assistant completion or arbitrary activity. The [Session view](src/session-view.ts) reads cached projections without loading every Session log. Legacy requests omit navigation metadata. Update the PC before using the navigation-requesting phone; see [compatibility and update order](../../../docs/upgrade-guide/v0.1.15/companion-navigation/guide.md).

### Open existing chats

The phone can explicitly open an eligible existing ordinary chat on the running PC without changing Desktop navigation. `getSessionActivation` reports its separate PC permission; only `openSession` invokes activation, while session listing, history and progress reads never activate a cold Agent. The `sessionActivationV1` grant is default-denied and independent of pairing, chat management, model selection and tool details. Desktop Main's native **Paired phones** dialog exposes **Enable opening chats** after fingerprint comparison. Cold activation uses normal PC Agent initialization and flushes only the target Session; initialization may migrate or repair history or run SessionStart plugins, even if it fails. After admission, API ownership continues despite phone cancellation, so the reply may be `unknown`. Opening creates no Session or task and sends no text. See [session activation and update order](../../../docs/upgrade-guide/v0.1.17/companion-session-activation/guide.md).

### Models and tool details

Independent native PC decisions enable model selection and tool details for the exact phone fingerprint. Model choices use PC-configured routes for a live idle ordinary chat with no queued work; they affect that chat's next request, not global defaults. Tool details expose workspace-relative file labels, read windows, fixed write/edit outcomes and search counts from history and live activity. Filenames may be sensitive; withdrawal stops future delivery but cannot erase received text. See [update order and record compatibility](../../../docs/upgrade-guide/v0.1.17/companion-model-and-tool-consent/guide.md).

Details use allowlisted successful-result metadata and exact call correlation, not arguments, contents, diffs, shell commands or error text. External paths and malformed metadata are omitted; unavailable correlation produces a fixed status. Tool names and metadata assume trusted PC tool composition rather than authenticated producer identity. Nested PTC details are unavailable.

### Pairing and follow-up authority

Desktop Main copies the one-time native URL through private IPC and owns fingerprint approval and removal dialogs; the renderer receives only availability, connection state and paired count. The native app can paste the URL; this package claims no QR generation. The operator approves exactly the displayed candidate and fingerprint. **Follow-up text can cause the existing PC Agent to run its normal tools and tasks under that Session's existing permissions.** The companion does not add tool-approval authority.

The phone must not automatically retry a submission. A `submitted` result means only in-memory inbox admission, not durable delivery, execution, task completion or a receipt. Loss before that acknowledgement, including checkpoint failure after admission, means delivery is unknown. Offline mutations are not queued or resent.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

A boot-installed Desktop capability and a non-expiring kernel lock restrict this connector to one owner per canonical local home. A paused or unresponsive process retains exclusion; another process cannot take ownership based on a stale heartbeat. The existing credentials service stores the private PC identity and current grants. The outbound WSS connector signs a fresh relay-issued socket challenge; forwarded relay identities alone never authorize a phone. The shared protocol validates the complete signed phone hello, pairing HMAC, PC welcome and mutual encrypted key confirmations. A current grant generation and a synchronously revocable channel signal authorize each application dispatch and final follow-up admission.

Cold text history uses caller-owned query leases without Agent activation. Results contain bounded summaries, approved literal text and separately authorized tool metadata, never raw tool payloads, reasoning or arbitrary projections. Complete encoded messages pay the UTF-8 budget. Read cursors are authenticated and context-bound. Live watches retain only bounded pending call identities; immutable history observations resolve earlier calls without synchronous Session log reads.

The [build configuration](tsdown.config.ts) emits the provider and `/desktop-control` codec as independent Node entries. Desktop's [bundle configuration](../../../apps/desktop/tsdown.config.ts) inlines the codec and its protocol dependency rather than leaving an unpackaged runtime import; Main does not load the Host provider.

[Service](src/index.ts), [connector](src/connector.ts), [records](src/records.ts), [Desktop ownership](src/desktop-owner.ts), and [application dispatch](src/application-dispatch.ts) own the exact implementation.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Architecture](../../../docs/architecture.md): existing Session and plugin ownership.
- [Shared protocol](../../util/companion-protocol/README.md): cryptographic transcripts and application JSON.
- [Relay](../companion-relay/README.md): live routing and deployment admission.
- [Integration](INTEGRATION.md) ([中文](INTEGRATION.zh.md)): native link, storage and Desktop-owned wiring.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through ordinary Session user-text admission and Agent request assembly; this package adds no model tools or prompt sections.

#### KV Cache effect

Admitted follow-up text affects context and KV-cache reuse exactly as ordinary queued PC user text; reads and pairing do not add model requests.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

The following integration and verification constraints remain explicit.

- Physical Android interoperability and native Windows security acceptance require separate validation; keyless tests and static compilation do not establish them.
- Activation requires a real deployed relay origin, explicit budgets and an offline Desktop build. No running application or installed credential data is changed by editing source.
- The signed hello has no display-name metadata; candidate and device names remain empty. Shared application status has no local-PC-action state. Partial assistant deltas require a separate bounded protocol representation and are not exported.
- Windows credential ACL verification remains deferred. Copying a PC credentials home clones its private identity; the local-home lock does not prevent ownership on another PC or another copied home.
- The credentials provider retains its last-good read cache after a source failure. Companion checks its permanent source-failure signal before initial admission and withdraws on `credentials/source-failed`; restoring storage requires provider and Host restart before phone authority returns.
- The credentials provider uses atomic replacement without fsync. Withdrawal completion means provider commit and channel quiescence, not power-loss durability stronger than that provider offers.
- Native interoperability, adversarial relay/channel behavior, application transcript snapshots, and assembled Desktop/Android end-to-end evidence remain required for deployment acceptance.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
