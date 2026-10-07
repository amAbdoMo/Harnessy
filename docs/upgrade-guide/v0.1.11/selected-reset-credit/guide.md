---
kind: upgrade-guide
description: "Account reset-credit Remote callers must supply the selected provider credit ID."
---

# Select a reset credit before redeeming

English | [中文](guide.zh.md)

## Change

`accounts.consumeResetCredit(accountId, idempotencyKey, signal)` becomes `accounts.consumeResetCredit(accountId, creditId, idempotencyKey, signal)`. Custom browser clients and Remote callers must supply an individual provider-issued credit ID; automatic selection is not supported. Stored accounts and usage summaries do not change.

## Migration

1. Read `accounts.listResetCredits(accountId, signal)` when the user opens the reset chooser.
2. Offer credits with `status: 'available'` and `resetType: 'codex_rate_limits'`; disable credits whose reported `expiresAtMs` has passed. Missing expiry must remain explicitly unreported.
3. Pass the chosen row's branded `AccountResetCreditId` as `creditId`; keep its value verbatim. Reuse the same idempotency key when retrying that account and credit; generate a different key for a different credit.
4. Confirm that opening the chooser makes no redemption request and selecting a row sends that row's ID. Refresh the credit list after a settled redemption outcome.
