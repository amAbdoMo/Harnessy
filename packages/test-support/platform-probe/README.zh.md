---
description: "面向仓库测试的主机能力探测：本机能否创建真实符号链接，使符号链接测试在有该权限的主机上照常运行，而不按平台跳过。"
kind: "package-library"
---

# @deepseek-ai/dsh-platform-probe

[English](README.md) | 中文

## 概述

本库为仓库测试回答一个问题：本机能否创建真实符号链接。在 Windows 上这需要开发者模式或 SeCreateSymbolicLinkPrivilege，因此答案是能力而非平台，持有该权限的 Windows 主机仍会运行本探测所约束的每项测试。在 `skipIf` 守卫中调用 `symlinksUsable()`。探测会在新临时目录中创建一个真实符号链接、删除该目录，并把答案缓存到进程级；它从不抛出。若某测试只需要目录别名，请沿用仓库中无需权限的 junction 惯用法。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

### 何时使用

当某个测试必须创建真实符号链接，并依赖链接本身的语义时使用它：悬空链接、逃出沙箱根的链接、`lstat` 的符号链接身份，或由 `readlink` 式断言读取目标文本的链接。只需要目录别名的测试应改用仓库的 `symlinkSync(target, alias, process.platform === 'win32' ? 'junction' : 'dir')` 惯用法，它在任何主机上都无需权限。

### 入口

在收集阶段守卫测试，并写明守卫存在的原因：

```ts
import { symlinksUsable } from '@deepseek-ai/dsh-platform-probe'

// A real symbolic link needs Developer Mode or SeCreateSymbolicLinkPrivilege on Windows.
it.skipIf(!symlinksUsable())('follows a dangling link', async () => { /* ... */ })
```

`symlinksUsable()` 返回本机是否成功创建了探测链接；若钩子会创建链接，则用 `describe.skipIf(!symlinksUsable())` 覆盖整个套件。必须写成调用：裸名 `symlinksUsable` 是函数值，`!symlinksUsable` 恒为 `false`，会让每个受约束的测试静默运行。绝不要以 `process.platform === 'win32'` 作为守卫，那会跳过本可创建链接的 Windows 主机。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

### 设计

探测度量的是能力而非平台。在非 Windows 上它直接返回 `true`，不触碰文件系统，因为 POSIX 主机无需权限。在 Windows 上它通过 `mkdtempSync` 创建一个临时目录，在其中写入文件，以显式的 `file` 类型创建指向该文件的符号链接，并通过 `lstatSync(link).isSymbolicLink()` 确认结果。

显式类型使答案诚实：Windows 在无法创建真实符号链接时会拒绝，而不是替换为 junction——后者会让较弱的探测在本仍无法运行上述测试的主机上通过。所有步骤都在同一个 `try` 内，因此权限被拒、临时目录不可读或结果并非符号链接都返回 `false`。`finally` 在成功与失败路径上都会删除临时目录并吞掉清理失败，使答案与清理无关。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | `symlinksUsable`：每进程一次的探测及模块级缓存 |
| — | 不发布运行时不变式伴生入口，因为本探测不拥有 Cordis 事件流，也不拥有共享数据；其约定是纯粹的主机能力读取。 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [测试策略](../../../docs/testing.zh.md)——本探测所服务的平台适配与自跳过约定。
- [开发](../../../docs/development.zh.md)——如何从源码检出运行单个测试。
- [test-support 组地图](../README.zh.md)——兄弟 harness 与支持包。

-----

<a id="model-experience"></a>
## 模型体验

无，本探测只为测试读取一项主机能力，不注册任何面向模型的内容。

#### KV Cache 影响

无；它从不组装或发送模型请求。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

这些约束对当前探测成立：

- **仅一项能力。** 本探测只回答符号链接问题；再增加主机能力应新增探测模块，而不是在此加宽参数。
- **首次调用固定本进程的答案。** 首次调用之后才获得开发者模式的主机，在进程重启前仍报告缓存结果。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
