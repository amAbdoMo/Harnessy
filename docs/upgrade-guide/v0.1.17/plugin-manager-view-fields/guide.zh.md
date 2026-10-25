---
kind: upgrade-guide
description: "插件包查询要求显式字段，组合包清单包含注册表更新资格。"
---

# 插件查询字段与更新资格

[English](guide.md) | 中文

## 变更

`@deepseek-ai/dsh-plugin-manager/operations` 的 `viewProfilePackage(dir, spec, options)` 要求 `PackageViewOptions.fields`，即传给 `pnpm view` 的字段。`BundleInfo.updatable` 是必填布尔值，表示管理器是否能检查并更新注册表依赖。agent 工具在现有组合包列表结果中省略此仅供 UI 使用的字段。

## 迁移

1. 传入 `fields: ['name', 'version', 'description', 'dsh']` 以保留普通包查询。兼容性预检读取 `engines` 与 `peerDependencies`；版本列表请求其自身所需的注册表字段。
2. 为清单生产方和测试替身补充 `updatable`。真实 profile 依赖的更新资格由 Host 管理器决定。
3. 运行类型检查，再经变更的消费者验证清单、查询与版本检查。JavaScript 中省略 `fields` 可能改变包管理器输出，必须修正。
