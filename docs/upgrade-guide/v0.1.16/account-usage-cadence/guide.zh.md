---
kind: upgrade-guide
description: "当前账户的用量缓存改为自适应间隔，不再采用单一固定最小间隔。"
---

# 自适应账户用量刷新

[English](guide.md) | 中文

## 变更

`settings-controller` 条目默认缓存当前账户用量 60 秒，在已用比例达到 75%、90% 和 99% 时，分别缩短为 30、15 和 5 秒。此前采用固定的 30 秒最小间隔。`activeAccountUsageRefreshMs` 现在提供基础间隔，`accountUsageRefreshTiers` 可进一步缩短它。当前账户读取失败后通常在五秒后重试，自动 HTTP 429 读取遵循有上限的 Retry-After 冷却时间。非当前账户的缓存间隔仍为五分钟。

浏览器账户响应可能包含可选的 `usageRefreshIntervalMs` 调度元数据。已保存的账户记录和凭据无需迁移。

## 迁移

1. 保留默认值即可使用自适应刷新。如果 profile 需要保留此前当前账户的固定间隔，请编辑其 `cordis.patch.yml` 中的 `settings-controller` 条目：

   ```yaml
   - id: settings-controller
     config:
       activeAccountUsageRefreshMs: 30000
       accountUsageRefreshTiers: []
       failedAccountUsageRefreshMs: 30000
       accountUsageMaxRetryAfterMs: 30000
   ```

2. 如此前使用自定义间隔，请将相应的 `30000` 替换为该值。显式设置 `activeAccountUsageRefreshMs: 0` 仍会禁用成功读取的缓存。显式最新刷新会绕过用量缓存和冷却时间。
3. 重新加载 profile，确认窗口可见期间的自动额度更新遵循所选间隔。模型请求仍使用已提交的账户状态，不会等待用量读取。
