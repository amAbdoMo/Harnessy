# Agent Note: Harnessy identity as a product profile layer

Status: implemented

English | [中文](2026-09-08-custom-harness-brand-identity.zh.md)

## Problem

The fork needed an independent visible identity and writable state while retaining DeepSeek Harness as the upgradeable framework. Branding was spread across build-time document metadata, PWA install metadata, shell slot fallbacks, the first-run notice, and profile composition. A repository-wide rename would have damaged package names, provider identities, protocols, legal notices, and upstream mergeability, while reusing `DSH_HOME` would have allowed the stock and custom products to overwrite each other's settings and sessions.

## Decision

Harnessy is a named build and runtime profile, implemented as a narrow layer over the existing Web application. The internal `custom-harness` profile, application ID, protocol, and `%LOCALAPPDATA%\CustomHarness` state root remain stable compatibility identifiers.

- `scripts/custom-harness-product.ts` is the authoritative identity record for display name, slug, Windows identifiers, protocol, filesystem directory names, product links, manifest short name, and icon path. The `custom-harness` client build profile projects its public subset into browser artifacts.
- `dsh --profile custom-harness` composes `dsh-base`, `dsh-web-app`, then `dsh-custom-harness`. The final patch disables only the stock brand and feedback rows, inserts `dsh-client-ui-brand-custom-harness`, and supplies product-facing Web command help.
- The client package occupies the sidebar mark and name, conversation hero mark and orientation, General settings About row, and theme-token seams. Its reversible light/dark palette uses the supplied logo's deep navy, ocean teal, and cyan colors through semantic tokens. The supplied transparent mark is presented on a compact gradient frame in the interface, while the supplied filled artwork is the favicon, executable, installer, and shortcut source.
- `scripts/run-custom-harness.ts` ignores ambient `DSH_HOME` and selects `%LOCALAPPDATA%\CustomHarness\Harness` by default, with sibling Logs and Cache directories. Product-specific overrides exist for tests and managed deployments; automatic stock-state import does not.
- The static source manifest and stock brand package remain intact. Build-time transformation produces the Harnessy title, favicon, and PWA metadata only for the named product build.

## Alternatives considered

- **Global search-and-replace** — rejected because internal package IDs, provider names, API contracts, and notices are compatibility surfaces rather than product chrome.
- **Modify the stock Web bundle in place** — rejected because the stock and custom applications must coexist and continue to build from the same source tree.
- **Reuse `DSH_HOME` and add a UI label only** — rejected because identity without state isolation would permit cross-product settings and session collisions.
- **Create a second application runtime** — rejected because the profile and slot systems already provide the intended extension seams; another launcher stack would duplicate framework behavior.

## Consequences

The two profiles can initialize and restart under separate roots, while product branding remains a removable final bundle layer. Shared interaction, streaming, session, approval, attachment, reconnect, and error paths keep their existing owners; the custom layer changes presentation and slot content only. The fork keeps upstream package and legal identities, and all visible product values in the custom browser build trace to the centralized build record. Windows packages now use `Harnessy.exe` and `Harnessy-Setup-*` while retaining the existing application ID and state root so installed upgrades preserve local sessions and credentials.
