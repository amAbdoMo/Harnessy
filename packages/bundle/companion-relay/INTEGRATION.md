# Companion relay parent integration

This source-only handoff does not activate a profile, deploy a relay, install dependencies, or supply Android UI. The parent owns the following changes outside the three authorized package trees.

## Repository wiring

- Add `PROFILE_TEMPLATES['companion-relay'] = { bundles: ['@deepseek-ai/dsh-companion-relay-bundle'] }` in [profile.ts](../../boot/app-boot/src/profile.ts); do not use the unknown-profile fallback because it inherits `dsh-base`.
- Add the bundle to the launcher resolver dependencies in the [CLI manifest](../../../apps/cli/package.json), and reconcile the lockfile through the normal parent-owned dependency workflow. All third-party versions requested here already exist in the workspace; this handoff performs no installation.
- Register the three package projects in the Host aggregate, add their bare package source paths to the base resolution map, and classify runtime/development imports in the dependency checker. The package-local configs declare their direct workspace references. The root tsdown Host pass discovers package manifests and bundles emitted `index`/`startup` entries; no new raw Node app, executable, or independent web server entry is required.
- Add README Model Experience `none` classifications, documentation ownership/budget records, bilingual pairing records, and any generated configuration/module documentation required by the repository. Keep protocol details owned by [the protocol package](../../util/companion-protocol/README.md), not by root catalogs.
- Add profile-level CLI and published-artifact acceptance checks after the resolver and lockfile are integrated. The package regressions are source only and have not run. Do not claim a supported launch until the template, artifacts, deployment origin, and budget data are present.

## PC and Android consumers

- Implement the PC connector separately: persistent identity and grant/invitation storage, atomic one-time invitation consumption, explicit user authorization, revocation, approved Session projections, bounded inbox admission, and a local single-owner lock per Harness home. One relay PC owner is not a substitute for this local lock.
- Implement the native Android APK source separately using Java-compatible P-256 SPKI/DER, HKDF-SHA256, and AES-GCM. Keep PC identity pinning, phone private-key custody, deployment-origin validation, reconnect ownership, and literal text rendering native; do not substitute a PWA.
- Verify peer role, identity, route, socket incarnations, channel ID, grant/generation, request correlation, counters, and both encrypted confirmations before application dispatch. On every reconnect create fresh nonces and ephemeral keys, abandon old subscriptions, and display delivery unknown for mutations whose acknowledgement was lost. Never automatically retry `submitText`.
- Enforce the explicit application budget's per-grant retention/time fields in the PC connector in addition to process-wide limits; the protocol parsers enforce only wire bytes, field counts, and field validity. There is no receipt lookup or durable submission ledger.

## Deployment and acceptance ownership

The deployment operator supplies a real canonical HTTPS origin and a same-host managed TLS reverse proxy, preserves the public Host, blocks direct upstream access, and applies TLS/HTTP/upgrade/connection/traffic limits before the Node upstream. The relay intentionally ignores forwarded IP headers; a same-host proxy therefore shares one transport IP budget across clients. Changing that policy requires an explicitly configured trusted-proxy implementation, not enabling blind forwarded-header trust.

Before activation, the parent runs focused no-emit type checks, protocol and relay behavior regressions, Loader composition/disposal, bilingual/documentation gates, dependency/hygiene checks, published Node import smokes, and Node-versus-Android interoperability verification. Manually verify malformed/replayed proofs, wrong Host/path/role, unknown PC, duplicate PC owner, destination replacement races, fragment/queue/rate/time limits, slow readers, revocation, and lost acknowledgements. No tests, checks, builds, browser/server/provider calls, cloud deployment, credentials access, commits, or pushes are represented as executed by this handoff.
