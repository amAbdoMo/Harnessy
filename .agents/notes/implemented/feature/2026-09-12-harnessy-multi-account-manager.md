# Agent Note: Harnessy multi-account manager

Status: implemented

English | [中文](2026-09-12-harnessy-multi-account-manager.zh.md)

## Problem

Harnessy could authorize one OpenAI account, but changing identities required signing out and replacing the only canonical credential. Users with several personal provider accounts could not see which identity was active, preserve another identity locally, or compare the supported quota windows before switching. Treating every provider as if it exposed the same subscription usage API would also create misleading data.

## Decision

This decision partially supersedes the single-account presentation in [Custom Harness OpenAI account login](2026-09-09-custom-harness-openai-account-login.md). Its narrow `openAIAccount` compatibility namespace remains implemented, while the Models settings seat now uses the multi-provider manager.

`dsh-api-settings-controller` owns an `accounts` Remote namespace and a versioned `account-manager/accounts` credential record. The record is a Host-only vault containing provider-owned credential records, local labels, one active account id per provider, and redacted usage snapshots. The canonical `llm-pi-ai/<provider>` record remains the credential used by model requests. Activating an account copies its credential from the vault to that canonical address and enables the matching settings route.

The first managed set contains Codex (`openai-codex`), GLM (`zai`), Kimi (`kimi-coding`), OpenCode (`opencode`), and Claude Code (`anthropic`). Codex, Kimi, and Claude Code reuse installed OAuth flows and HTTPS native-browser opening. GLM and OpenCode accept API keys directly into the credential provider. Existing canonical credentials are imported on first description, so the feature does not require signing in again.

Only Codex currently advertises usage availability. Opening the manager always invokes `refreshUsage`; the Host refreshes an expiring Codex OAuth credential under the provider implementation and requests authenticated quota windows. Other providers remain fully addable and switchable but return no invented usage values. The client animates each returned percentage from zero to its target and disables the transition for reduced-motion users.

Remote responses contain account labels, provider ids, active state, initials, timestamps, and usage percentages only. API keys, access tokens, refresh tokens, and complete credential records never cross the Host boundary.

## Alternatives considered

- **Replace the canonical credential file with a second standalone account file** — rejected because it would duplicate storage, permissions, locking, and refresh responsibilities already owned by the credential provider.
- **Make the browser own the account vault** — rejected because browser storage and Remote responses would then carry reusable secrets.
- **Expose the whole authorization prompt protocol in this first manager** — deferred because the selected OAuth providers complete through a native browser callback or provider device page, while API-key providers have a dedicated secret input.
- **Scrape provider dashboards for every quota** — rejected because those pages are unstable and several providers do not publish a supported authenticated usage service for third-party clients.
- **Display stale usage until the user presses Refresh** — rejected because the manager is intended to support an immediate account-switch decision; opening it therefore performs a refresh automatically.

## Consequences

Users can preserve several accounts per supported provider and switch the credential used by new model requests with one action. Removing an active account promotes another saved identity when available or disables that provider route when none remains. Codex quota windows are refreshed on open and can also be refreshed manually. Provider-specific usage gaps are visible instead of silently showing zero.

The vault intentionally copies provider credential records, so every future provider-format migration must preserve both the canonical record and managed copies. Focused Host and client tests cover canonical import, secret redaction, API-key account lifecycle, OAuth addition without replacing the active account, Codex quota parsing, automatic refresh on open, switching, and animated bars.
