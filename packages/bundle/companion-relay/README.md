---
description: "Compose a standalone live ciphertext relay profile with explicit HTTPS deployment identity and budgets, without agents or model providers."
kind: "package-bundle"
---

# @deepseek-ai/dsh-companion-relay-bundle

English | [中文](README.zh.md)

## Summary

A dedicated profile can serve bounded live companion ciphertext behind a managed TLS reverse proxy. PCs self-register by canonical identity, and phones reach only their selected online PC. This layer contains no agents, sessions, provider configuration, PC login tokens, or generic gateway. Deployment identity and every relay budget must be supplied explicitly.

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

The [manifest](package.json) declares `dsh.bundle.patch`; this is a profile layer, not a raw Node app or package executable. The supported launcher is `dsh --profile companion-relay`. Parent integration must register that template, its CLI dependency, source aliases, aggregates, dependency lock entries, and package classifiers before the profile is available. Do not stack this bundle over `dsh-base` or another application bundle.

### MANUAL profile/deployment acceptance — not executed

The following commands identify the profile entry path and optional layer management operations. They have not been run; do not interpret them as installation, deployment, or verification evidence. A deployment owner must complete parent integration, package resolution, and managed TLS proxy configuration first.

```text
# MANUAL only: inspect the profile-owned grammar after integration.
dsh --profile companion-relay --help
# MANUAL only: start with operator-supplied bind environment and all relay budgets.
dsh --profile companion-relay
# MANUAL only: optional layer management in this dedicated standalone profile.
dsh plugin --profile companion-relay add @deepseek-ai/dsh-companion-relay-bundle
dsh plugin --profile companion-relay remove @deepseek-ai/dsh-companion-relay-bundle
```

The profile owns only `--host`, `--port`, and `--help`. `--host` must explicitly be `127.0.0.1`; otherwise set `DSH_COMPANION_RELAY_BIND_HOST=127.0.0.1`. Supply `--port` or `DSH_COMPANION_RELAY_BIND_PORT` as an integer from 0 through 65535. No browser is opened and no credential-bearing URL is printed. The same-host reverse proxy must terminate TLS and keep the HTTP backend private; raw backend exposure is unsupported.

Set `DSH_COMPANION_RELAY_HTTPS_ORIGIN` to the deployment's actual canonical HTTPS origin. There is no sample hostname fallback. Every numeric field is explicit: the [patch](cordis.patch.yml) lists the exact `DSH_COMPANION_RELAY_*` environment variable for each [relay Config field](../../host/companion-relay/src/config.ts). Missing or invalid values fail activation. A higher profile/home/invocation patch can replace a row's complete config instead of reading these variables; it must preserve startup gating and supply every relay field.

Before deployment acceptance, perform the relay's [MANUAL deployment checklist](../../host/companion-relay/README.md) against the real origin, including certificate/Host/path checks, upstream quotas, both identity proofs, PC-owned authorization, encrypted-record tamper/replay rejection, slow-reader termination, and quiescent Loader reload. These checks are required and unexecuted.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The [complete patch](cordis.patch.yml) inserts only the profile's [startup parser](src/startup.ts), the loopback [webserver](../../host/webserver/README.md), and the [ciphertext relay](../../host/companion-relay/README.md). The startup parser publishes bind values only after command acceptance; webserver and relay rows inject that signal, so help/rejection starts no transport. No `dsh-base`, timer service, model adapter, app Session, or storage row is inherited. The relay owns its own effect-bound timer. Ordered profile/home/invocation patches remain normal complete-row overrides.

The package exports its inert bundle entry and named `/startup` plugin. The workspace tsdown Host pass consumes TypeScript-emitted `index` and `startup` entries; no new launcher or package bin exists. [Shared companion protocol](../../util/companion-protocol/README.md#wire-reference) is the sole owner of cryptographic encodings and endpoint message definitions; the relay package owns transport limits and volatile routing.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Relay plugin](../../host/companion-relay/README.md) — budgets, state ownership, and manual HTTPS acceptance.
- [Shared companion protocol](../../util/companion-protocol/README.md) — canonical authentication and encryption reference.
- [Architecture](../../../docs/architecture.md) — profile layers and supported launch.
- [Minimal SDK bundle](../sdk-minimal/README.md) — another independently composed application tree.

-----

<a id="model-experience"></a>
## Model Experience

None, as this standalone bundle inserts no agent, session, tool, prompt, schema, or model-provider plugin.

#### KV Cache effect

None; the composed relay never assembles or sends provider requests.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- The bundle depends on external managed TLS and independent upstream client-IP, HTTP/header, connection, fragment/frame/byte-rate, TLS-handshake, and timeout limits. Forwarded headers do not establish relay source identity; a same-host proxy shares its relay IP quota.
- Only process-local online routing exists; no offline task queue, storage, session ledger, or distributed rendezvous is included. Identity authentication does not replace PC-owned pairing, grants, or revocation.
- Profile registration and repository-wide integration belong to the parent change. Installation, applications, servers, tests, builds, documentation pairing/gates, network operations, and live deployment acceptance have not been executed here.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
