---
description: "Harnessy 的委派设置页面：供运维者在浏览器中管理 Command Code 通道、运行上限与工作区覆盖。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-settings-commandcode

[English](README.md) | 中文

## 概述

本包为 Harnessy 的设置贡献顶层 **委派** 页面。它报告已安装的 Command Code CLI 的检测状态、版本与登录状态；编辑全局通道目录与三项运行上限；并以逐字段的继承/已覆盖状态与重置控件管理按工作区的通道覆盖。它仅在浏览器产物按 `custom-harness` 配置档构建时注册，因此其他产品不会显示该页面。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

与 Host 插件一同挂载客户端行。`custom-harness` 产品补丁层已同时包含两者。

```yaml
- id: ui-settings-commandcode
  name: '@deepseek-ai/dsh-client-ui-settings-commandcode'
```

该页面以设置导航中的 `委派` 条目出现。它通过共享设置作用域读取 `commandcode-delegation` 设置分区，并通过 `commandcode` Remote 命名空间读取安装、目录与已解析通道的事实。

### 页面管理的内容

| 区域 | 用户可做的操作 |
|---|---|
| Command Code CLI | 查看是否检测到 CLI、报告的版本以及是否已登录；按需重新检查，并在未登录时看到确切的登录命令 |
| 运行限制 | 设置并发上限、单次运行的超时分钟数以及轮数上限 |
| 通道 | 添加、重命名、启用、禁用与删除 **全局** 通道；编辑每个通道的用途、指令、带可搜索目录选择器与手动 id 回退的精确模型、推理强度与访问级别。这些卡片承载的是所有工作区继承的值，因此不显示任何按工作区分化的标记 |
| 工作区覆盖 | 针对会话所在的工作区，编辑任意通道的任意字段；每个字段都会显示此工作区是覆盖了它还是继承了它，并可逐字段或按整个通道重置回继承状态 |

工作区编辑器会列出每个通道的每个字段，包括尚无任何工作区覆盖过的字段，因此第一条覆盖是通过编辑字段创建的，而不是先新增条目。布尔字段是复选框，枚举字段是下拉框，长文本指令是文本域；不会有任何内容被字符串化塞进通用文本框。重置会清理被清空的通道条目与工作区条目。

完全访问会在原处标注其代价：CLI 以 `--yolo` 运行，可能在工作区中不经询问地修改文件并执行命令。

### 文案与可访问性

所有字符串都来自 `commandCodeDelegation` 字典，该字典以英文和中文注册。控件为原生输入框、下拉框与按钮，通过自身文本或显式 `htmlFor` 标注，且每个编辑器都有可见的共享焦点环。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

### 源码导图

| 文件 | 作用 |
|---|---|
| [`src/client/index.ts`](src/client/index.ts) | 插件入口：配置档门控、字典、设置作用域、Remote 操作、槽位注册 |
| [`src/client/DelegationSection.tsx`](src/client/DelegationSection.tsx) | 页面：CLI 状态、上限、通道卡片、工作区覆盖 |
| [`src/client/edit.ts`](src/client/edit.ts) | 纯分区编辑——通道字段、添加、删除、覆盖、重置、id 生成，以及有序字段清单 |
| [`src/client/contract.ts`](src/client/contract.ts) | 浏览器安全的section形状及其解码器 |
| [`src/client/delegation-section-store.ts`](src/client/delegation-section-store.ts) | 设置作用域的渲染层镜像 |
| [`src/client/locales.ts`](src/client/locales.ts) | 英文与中文字典 |

### 设计要点

- **Host 解析，浏览器渲染。** 通道继承与工作区解析在 Host 上只计算一次，并通过 `delegation` Remote 方法读取，因此浏览器不会重新推导运行实际会使用的内容。
- **文本字段保有本地草稿。** 设置写入会在按键后一个往返周期才抵达镜像快照，因此每个文本与文本域控件都会保留用户输入的内容，并采纳外部提交的取值，而不会被自身的写入重置。
- **编辑基于编辑器当下的分区组合。** 每次编辑都作用于编辑器当前显示的分区，并且只写入它真正改动的顶层字段，因此同一次设置往返周期内的两次编辑不会因为从过期渲染重新推导而互相覆盖。
- **已解析视图跟随每一次被接受的写入。** 每次写入后 Host 会重新解析工作区，页面随之重新读取，因此继承/覆盖状态与重置控件都会收敛到已提交的文档；当有更新的读取取代它或页面卸载时，每次读取都会被中止。
- **删除通道是分区编辑，而非级联。** 删除通道时会在同一次写入中一并删除所有针对它的工作区覆盖。
- **没有目录也能新建可用通道。** 当此浏览器尚未读取 CLI 的参考清单时，新通道会从文档化的默认模型开始，因此手动精确 id 回退永远不会是让通道可保存的唯一途径。
- **按配置档门控。** 除非浏览器产物按 `custom-harness` 构建，`apply` 会提前返回。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [Command Code 委派插件](../../subagent/subagent-commandcode/README.zh.md) —— 拥有设置分区与工具的 Host 部分。
- [Harnessy 产品补丁层](../../bundle/custom-harness/README.zh.md) —— 挂载两部分的配置档。
- [设置分区槽位](../ui-settings/README.zh.md) —— 本页面注册所用的槽位契约。

-----

<a id="model-experience"></a>
## 模型体验

无。该包是浏览器端设置页面，不注册任何工具、提示词分区或模型可见文本。

#### KV Cache 影响

无；该包既不组装也不发送提供方请求。它写入的通道只改变 Host 插件工具在下一次委派时报告的内容，而不改变任何请求的内容或顺序。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- **组件渲染由共享的 jsdom 通道覆盖** —— 页面自身逻辑位于 `edit.ts` 与 Host 中，两者都有直接单元测试；渲染测试在该通道可用时通过 Testing Library 检验页面。
- **工作区覆盖编辑器显示已存储的覆盖，而非工作区选择器** —— 页面为会话自身的工作区解析覆盖；没有工作区的会话只提供全局通道。
- **模型目录仅供参考** —— 在手动输入精确 id 之外，提供基于 CLI `--list-models` 输出的可搜索选择器，因为格式变化后的列表不应阻塞通道编辑。
- **没有通道排序** —— 通道保持存储顺序；页面把新通道追加到末尾。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>面向维护者的工作上下文——点击展开</summary>

- **该分区从不启动进程** —— 安装与目录事实通过 Remote 命名空间获取；页面只负责请求。

</details>

**Runtime invariant:** 不发布伴随文件。设置文档由设置服务拥有，分区数据由 Host 插件的 Remote 命名空间拥有。
