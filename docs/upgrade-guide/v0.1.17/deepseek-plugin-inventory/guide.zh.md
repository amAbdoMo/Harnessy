---
kind: upgrade-guide
description: "DeepSeek 插件清单接收方必须接受没有版本的身份和不完整元数据。"
---

# DeepSeek 插件清单

[English](guide.md) | 中文

## 变更

`DeepSeekPluginPackageIdentity.version` 变为可选。`dsh_plugin_packages` 的版本 1 字段可以包含只有 `name` 的公开包身份。没有可用版本的私有包会被省略。包元数据不可读时，系统记录警告并省略该项，而不是使整个模型请求失败；可读的同级包仍会被包含。有版本身份的现有表示保持不变。

## 迁移

1. 更新 `DeepSeekPluginPackageIdentity` 的使用方及传输字段接收方，处理 `version` 缺失的情况。区分只有名称和带版本的身份；不要根据数组顺序推断包的激活情况。
2. 若不需要包诊断，在 profile patch 中现有的 `plugin-package-inventory-deepseek` 配置项上设置 `enabled: false`。参见[清单包](../../../../packages/llm/plugin-package-inventory-deepseek/README.zh.md)。
3. 使用一个没有版本的公开插件、一个没有版本的私有插件和一个可读的带版本同级包验证请求准备。结果应只包含公开包名称和带版本的同级包；损坏的元数据不能阻塞请求。
