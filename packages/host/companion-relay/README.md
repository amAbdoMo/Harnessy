---
description: "Configure bounded live PC/phone ciphertext rendezvous behind a managed HTTPS reverse proxy."
kind: "package-reference"
---

# @deepseek-ai/dsh-companion-relay

English | [中文](README.zh.md)

## Summary

PCs and phones can exchange live encrypted companion messages through one deployment origin. Each connection proves possession of its own P-256 identity key with a fresh, expiring socket challenge. Phones reach only their selected online PC; that PC owns pairing, grants, revocation, and application authorization. Operators must supply a managed TLS reverse proxy and every admission, byte, queue, and time budget.

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

Mount the named plugin beside `@deepseek-ai/dsh-host-webserver`, or select the [standalone bundle](../../bundle/companion-relay/README.md). The exact upgrade routes are `/companion/pc` and `/companion/phone`; plain HTTP responses remain the webserver's responsibility.

### Deployment configuration

All fields in [Config](src/config.ts) are required. The [bundle patch](../../bundle/companion-relay/cordis.patch.yml) maps each field to an explicit environment variable; a profile patch can instead replace the relay row's complete config. No public hostname or deployment budget is inferred. Missing, noncanonical, nonpositive, unsafe-integer, timer-overflow, or inconsistent configuration fails activation.

| Fields | Meaning |
|---|---|
| `httpsOrigin` | Real canonical HTTPS origin; no credentials, path, query, fragment, or trailing slash. |
| `maxConnections`, `maxConnectionsPerIp` | All admitted sockets, including anonymous sockets. |
| `maxPending`, `maxPendingPerIp` | Unauthenticated sockets before proof completion. |
| `maxRoutes`, `maxRoutesPerIp` | PC slots, including anonymous PC-route sockets. |
| `maxPhones`, `maxPhonesPerIp`, `maxPhonesPerPc` | Phone slots; target-PC limits include pending challenges. |
| `maxIpBuckets`, `ipBucketTtlMs` | Retained transport-source IP buckets and their inactive expiry. |
| `maxFrameBytes` | Complete incoming/outgoing UTF-8 JSON byte limit, including metadata. |
| `maxOutboundQueueBytes`, `maxChannelQueueBytes` | In-flight bytes per socket and per channel direction; slow readers terminate. |
| `bytesPerSecond`, `bytesPerSecondPerIp`, `bytesPerSecondPerSocket` | Byte token-bucket capacities and per-second refill; incoming and outgoing bytes both count. |
| `upgradesPerWindow`, `upgradesPerWindowPerIp`, `upgradeWindowMs` | Global/IP upgrade token buckets, including rejected authority requests. |
| `registrationTimeoutMs`, `challengeTimeoutMs`, `channelHandshakeTimeoutMs` | Registration, proof, and endpoint-handshake deadlines. |
| `idleTimeoutMs`, `maxConnectionLifetimeMs`, `sweepIntervalMs` | Application inactivity, absolute socket lifetime, and expiry scan interval. |

The proxy must preserve the exact configured public Host and both exact paths. A present Origin must equal `httpsOrigin`; absence is permitted for native clients, and Origin is never identity authentication. Duplicate Host/Origin headers, query strings, path suffixes, binary messages, malformed JSON, unknown fields/types/versions, repeated proofs, and stale socket generations close the transport.

The relay uses only `request.socket.remoteAddress`; it ignores forwarded IP headers. A same-host proxy therefore shares one IP bucket across clients. Apply independent upstream client-IP quotas, HTTP header/request-size limits, connection/upgrade limits, byte/frame/fragment rates, TLS handshake limits, and read/write deadlines. Do not expose the loopback HTTP backend directly or confuse TLS termination with end-to-end authorization.

### MANUAL deployment acceptance — not executed

A deployment owner must perform these checks against their actual HTTPS origin after parent profile registration and dependency integration. This is an acceptance checklist, not evidence of an executed deployment.

1. Verify a valid certificate, exact public Host preservation, exact upgrade paths, and a backend reachable only by the managed proxy; verify upstream header, fragment, connection, byte-rate, TLS, and timeout limits.
2. Verify absent native Origin succeeds, hostile Origin/Host and nonexact paths fail, unknown/offline PCs fail, and spoofed forwarded IP headers cannot bypass transport-source quotas.
3. Verify fresh canonical P-256 SPKI/DER SHA256withECDSA proofs for both roles; reject expired, copied-to-another-socket, modified-origin/target/key/role, and replayed proofs. Reject a duplicate live PC without displacing its owner.
4. Verify authenticated phone metadata and bound hello reach only the chosen PC; verify the PC refuses unauthorized pairing/grants and revoked authorization. Verify both endpoints reject modified/replayed encrypted records before application dispatch.
5. Exhaust each explicit admission/rate/retention limit; confirm inactive anonymous IP buckets expire. Stall readers and verify per-channel/direction and per-socket byte caps terminate sockets without offline delivery.
6. Reload/dispose the relay through Loader; verify both registrations disappear, all sockets/callbacks settle, and reconnect creates fresh generations, challenges, keys, and counters.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The [plugin](src/index.ts) owns one reversible upgrade-registration effect. The [relay](src/relay.ts) reserves global and IP slots before key parsing, consumes one stored challenge before proof verification, and retains only live sockets, PC routes, channels, queue counters, and expiring IP token buckets. One canonical identity owns each PC route; no operator allowlist exists. A phone's first bound hello creates its sole channel and sends authenticated identity/generation metadata to the PC. Subsequent frames cannot choose a destination or broadcast.

The [routing parser](src/wire.ts) accepts only role-specific control operations and the shared hello/welcome/encrypted JSON parsers. The relay checks routing identities and generations but never decrypts ciphertext or interprets pairing grants. The [shared protocol reference](../../util/companion-protocol/README.md#wire-reference) owns cryptographic encodings, transcripts, and endpoint messages. Teardown removes both routes before terminating sockets, waits for close/send-callback settlement, and compares connection/channel objects before deleting live owners.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Standalone relay bundle](../../bundle/companion-relay/README.md) — profile composition and explicit environment configuration.
- [Shared companion protocol](../../util/companion-protocol/README.md) — canonical identity proofs and encrypted endpoint messages.
- [Webserver](../webserver/README.md) — exact upgrade registry and transport ownership.
- [Architecture](../../../docs/architecture.md) — supported profile launch and composition.

-----

<a id="model-experience"></a>
## Model Experience

None, as this package relays ciphertext and introduces no agents, sessions, tools, prompts, schemas, or model-visible messages.

#### KV Cache effect

None; this package never assembles or sends provider requests.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Relay state is process-local and live-only: no offline queues, task storage, session ledger, persistence, or multi-instance rendezvous exists. PC disconnect closes all bound phones; HMR/restart requires fresh endpoint handshakes.
- Authentication proves key possession, not pairing or permission. The PC must enforce grants and revocation; the relay cannot detect endpoint misuse hidden in ciphertext. Endpoints own encrypted-record replay rejection.
- Native ping/pong control traffic terminates sockets and does not extend inactivity; clients and proxies must use application traffic and configured deadlines rather than WebSocket ping keepalives. Proxy-visible client identities require upstream quotas because forwarded IPs are deliberately ignored.
- Source composition regressions exist but have not been executed. Live HTTPS acceptance, type checking, documentation pairing/gates, package resolution, and built artifacts remain unverified; no deployment or production-readiness claim is made.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
