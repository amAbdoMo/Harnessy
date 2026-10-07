---
kind: upgrade-guide
description: "账户重置额度的 Remote 调用方必须提供所选 provider 额度的 ID。"
---

# 兑换前选择重置额度

[English](guide.md) | 中文

## 变更

`accounts.consumeResetCredit(accountId, idempotencyKey, signal)` 改为 `accounts.consumeResetCredit(accountId, creditId, idempotencyKey, signal)`。自定义浏览器客户端与 Remote 调用方必须提供单次 provider 额度的 ID；不支持自动选择。已存储的账户与用量摘要不变。

## 迁移

1. 用户打开重置选择器时读取 `accounts.listResetCredits(accountId, signal)`。
2. 提供 `status: 'available'` 且 `resetType: 'codex_rate_limits'` 的额度；禁用已超过所报告 `expiresAtMs` 的额度。缺失的到期时间必须明确标为未提供。
3. 将所选行带品牌的 `AccountResetCreditId` 作为 `creditId`，并保持原始值不变。重试同一账户与额度时复用相同的幂等键；选择另一额度时生成不同的键。
4. 确认打开选择器不会发送兑换请求，选择一行会发送该行的 ID。兑换结果结算后刷新额度列表。
