---
kind: upgrade-guide
description: "Android 导航请求要求 PC 支持 listSessions 导航视图；旧 PC 会拒绝请求并关闭通道。"
---

# 使用支持导航的 Android 伴侣前先更新 PC

[English](guide.md) | 中文

## 变更

Android 伴侣的普通对话列表现在通过 `listSessions` 请求 `view: 'navigation'`。匹配的 PC 返回只读 Workspace 成员关系、PC 置顶顺序和人工提示最近时间。不支持此扩展的 PC 仅接受旧请求字段：它们会拒绝新请求并关闭加密通道。手机配对成功不代表支持此列表 API。

对于省略 `view` 的旧请求，更新后的 PC 仍恰好返回 `sessionId`、`title` 和 `status`，因此现有手机可继续使用这些请求。心跳也省略视图。导航本身不增加 PC 修改权限，也不改变配对密钥或送达不确定性阻止记录。普通列表省略空 Workspace 分组；单独授权的目录和操作遵循[聊天管理升级指南](../companion-chat-management/guide.zh.md)。

## 迁移

1. 使用支持导航的手机应用前，先将 PC 更新为支持 `listSessions` 的 `view: 'navigation'` 的构建。在匹配的 PC 运行前保留现有手机版本；仅修改源码或生成新 APK 不会更新 PC。
2. 双方更新后继续使用现有配对。不要通过清除配对密钥、重置应用数据或丢弃送达警告来绕过被拒绝的列表请求。不得放宽精确字段解析，也不得增加宽松回退。
3. 确认手机可加载现有对话，且不会因列表请求导致通道关闭。对照 PC 检查 Workspace 分组和投影的 PC 置顶；未分配行保持无标题。元数据缺失时不得虚构组织信息。构建成功本身不代表实体设备或加密互操作验收通过。
