---
kind: upgrade-guide
description: "自定义 Session Controller 投影读取方须将延后迁移的提示与精确基线分开处理。"
---

# 冷 Session 投影回复

[English](guide.md) | 中文

## 变更

Session Controller 的 `projections` Remote 返回 `null`、`{ kind: 'sequenced', asOfSeq, values }` 基线，或 `{ kind: 'migration-required', values }` 缓存提示。此前非空回复没有 `kind`，且始终表示精确基线。自定义 Remote 客户端须处理新的判别字段。读取需要迁移的历史 Session 时，不再仅为提供投影而打开事件正文。

Session 摘要可包含 `formatStatus: 'current' | 'migration-required'`。状态缺失表示未知；已转换的逻辑头部不能说明存储中的物理代际属于当前格式。随产品交付的客户端会让延后提示保持可重试，而不激活 Session，也不将提示视作完整基线。

## 迁移

1. 使用配套的 Host、Client 与生成的 Remote 声明。更新自定义投影读取方，区分 `null`、`sequenced` 与 `migration-required` 回复。
2. 仅将 `asOfSeq` 应用于 `sequenced` 值。将延后值视作可选缓存提示：不得虚构序号、恢复精确基线已声明不存在的键，或将读取标为完成。保留显式刷新能力。
3. 忽略已退役连接代际的回复。不得仅为填充列表或悬停预览而激活、派生或迁移 Session。
4. 确认延后投影读取不改变保留的历史字节，也不创建后继文件。在另行请求激活或迁移后，确认新的精确基线取代这些提示。

投影与列表行为由 [Session Controller 参考](../../../../packages/api/session-controller/README.zh.md)持有。这些回复字段不要求修改 Session 格式版本、已提交的历史代际或默认 profile。
