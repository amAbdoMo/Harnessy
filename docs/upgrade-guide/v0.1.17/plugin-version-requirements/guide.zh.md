---
kind: upgrade-guide
description: "插件 engines.dsh 优先于 DSH peer 要求，结构化不兼容记录通过 requirements 替代 peers 暴露未满足的要求。"
---

# 插件版本要求

[English](guide.md) | 中文

## 变更

插件自身的 `engines.dsh` 范围决定其与当前 DSH 版本的兼容性。缺失时使用现有 DSH peer 依赖检查。插件与运行时精确版本豁免保留当前作用域。结构化兼容性结果及 plugin-manager 不兼容记录通过 `requirements` 替代 `peers` 暴露未满足的范围；键表示 `engines.dsh` 或 DSH peer 包。

## 迁移

1. 插件作者可在 `package.json` 的 `engines.dsh` 中声明运行时范围。使用有效的语义版本范围；该字段不支持 workspace 范围。
2. `PluginCompatibility` 与 `IncompatiblePlugin` 的消费者须读取 `requirements` 替代 `peers`，并在显示键时避免假定它们都是包名。
3. 分别检查一个具有受支持 `engines.dsh` 范围的插件和一个范围不受支持的插件。即使 DSH peer 范围不同，前者仍获准使用；后者除非存在精确版本豁免，否则被拒绝。没有 `engines.dsh` 的插件继续使用基于 peer 的准入检查。
