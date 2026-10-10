---
kind: upgrade-guide
description: "Reset redemption refreshes only the selected membership instead of refreshing all Codex accounts or triggering automatic account selection."
---
# Selected reset refresh scope

English | [中文](guide.zh.md)

## Change

`accounts.consumeResetCredit()` refreshes and commits usage only for the membership whose credit was selected. Its returned `AccountsState` still contains all saved accounts, but unrelated memberships retain their previous usage snapshots. Reset redemption does not trigger automatic account selection. Remote callers that relied on an all-account refresh or incidental failover after redemption must request that operation explicitly.

## Migration

1. Use `accounts.consumeResetCredit()` to redeem the selected credit and read that membership's refreshed usage from the returned state. Keep the same account-and-credit-specific idempotency key for an unconfirmed retry.
2. If your caller needs fresh usage for every Codex membership or enabled automatic account selection, call `accounts.refreshUsage(signal)` explicitly after redemption.
3. Confirm that redemption preserves the active identity and leaves unrelated memberships' usage timestamps unchanged; an explicit full refresh updates those memberships and retains the configured automatic-selection behavior.
