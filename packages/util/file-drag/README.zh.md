---
description: "Web 与 Desktop 共用的导出文件名及原生文件拖放请求。"
kind: "package-library"
---

# @deepseek-ai/dsh-file-drag

[English](README.md) | 中文

## 概述

调用方可在 Web 与 Desktop 使用相同的安全文件名导出文件。MIME 数据补全缺失后缀，不限制可接受的文件类型。该库还声明原生字节及授权资源请求，不持有文件或应用状态。

## 目录

- [使用此包](#use-this-package)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

<a id="use-this-package"></a>
## 使用此包

`resolveDragFileName({ name, mediaType, outputExtension })` 清理路径分隔符、保留字符与 Windows 设备名。显式输出后缀优先；否则保留兼容的已有后缀，已知冲突按声明 MIME 替换，缺失后缀从持续维护的 `mime` 数据库补全。未知类型保留调用方名称或后缀，无名内容以 `file` 命名。Desktop 在调用此类型化解析器前验证跨进程输入。

`DesktopFileDrag` 接受完整字节或 Session 资源地址，返回不透明句柄。资源借用必须经过 Host 授权与主进程的内容、名称检查；无法借用时，调用方回退到字节准备。[插件](../../client/ui-file-drag/README.zh.md) 负责浏览器准备，[Desktop](../../../apps/desktop/README.zh.md) 负责原生交付。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- 名称遵循调用方声明的 MIME；该库不检查内容，也不推断未知格式。显式后缀会有意覆盖 MIME 命名。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作背景</summary>

无。

</details>
