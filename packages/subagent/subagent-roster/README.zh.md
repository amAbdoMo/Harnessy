---
description: "统一子代理名册插件：面向定义具名子代理角色的运维者，以及选择由哪个角色执行委派任务的模型。"
kind: "package-reference"
---

# @deepseek-ai/dsh-subagent-roster

[English](README.md) | 中文

## 概述

名册是一个实时设置分区，拥有部署所提供的子代理角色。每个角色固定自己的后端、模型策略、沙箱访问级别、调用策略与常驻指令，因此委派调用只能给出角色名，既无法选择、也无法放宽其中任何一项。插件注册两个 token 稳定的模型可见工具：`list_subagents` 报告调用会话所在工作区已启用的角色，`delegate` 启动其中之一。前台调用与后台作业从同一个运行闸门取得并发名额。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发者备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

在配置档中挂载 Host 行。插件在加载时注册工具，不会启动任何子代理。

```yaml
- id: subagent-roster
  name: '@deepseek-ai/dsh-subagent-roster'
```

角色所指定的后端也必须注册；内置角色使用进程内的 `spawn` 提供者。

```yaml
- id: subagent-spawn-in-process
  name: '@deepseek-ai/dsh-subagent-spawn-in-process'
```

### 配置

组合配置不携带任何内容：用户调整的一切值都位于 `subagent-roster` 设置分区，工具在每次调用时都读取该分区，因此保存的修改会对已经运行的会话的下一次委派生效。

| 字段 | 默认值 | 含义 |
|---|---|---|
| `subagents` | `code`、`review`、`tests`、`docs`、`research`、`architecture` | 全局角色目录 |
| `overrides` | `{}` | 以规范工作区路径为键的按工作区角色补丁 |
| `automaticRouting.enabled` | `false` | 调用是否可以选择模型路由 |
| `automaticRouting.allowedModels` | `[]` | 显式选择必须解析到的精确 `{ provider, model }` 路由 |
| `limits.maxConcurrentRuns` | `2` | 允许同时运行的委派数，前台与后台一并计算（1–16） |
| `limits.defaultTimeoutMs` | `3600000` | 未指定时长的角色所用的墙钟上限（不超过 `MAX_TIMER_DELAY_MS`） |

### 角色

角色包含 `id`（模型逐字给出的 argv 安全令牌）、显示名 `name`、`enabled` 标志、一行 `purpose`、`whenToUse` 路由指引、`invocation` 策略、`model` 策略、`access` 级别、可选的 `tools` 作用域、常驻 `instructions`、可选的 `maxDepth`，以及指明 `backend`、`background` 调度与可选单角色 `timeoutMs` 的 `execution` 块。

内置的六个角色就是普通定义：没有任何逻辑会给内置 id 特权，因此用户可以编辑、禁用、复制或删除其中任何一个，而他们新增的角色行为完全相同。

### 访问级别

`access` 取 `inherit` 或某个沙箱模式。子代理的委派模式取其父代理有效模式与该角色访问级别中更窄的一个，因此角色只能收紧访问、绝不能放宽；`inherit` 记录的内容与今天未指定访问级别的委派完全一致。父代理的有效模式通过实时沙箱策略解析，因此即使父会话本身没有覆盖值，也能为单个子代理收紧部署默认值。插件不传递任何访问、沙箱或权限参数，因此工具边界上不存在提权。

### 调用策略

| 策略 | 路由在启动子代理前要求什么 |
|---|---|
| `automatic` | 除已启用的角色外无其他要求 |
| `ask-first` | 已组合的审批服务给出 `allowed-once`；其他任何结果、缺少服务，以及抛出异常的应答者都会拒绝启动 |
| `manual` | 直接人类回合：调用方必须是运行时根代理，且当前打开的回合必须包含由人类来源的消息 |

父代理的策略管辖父代理的 `delegate` 调用。子代理自身的审批策略始终固定为 `never`，因此 `ask-first` 不会削弱子代理对扩大自身作用域的保护。

### 模型路由

角色的 `model` 策略默认为 `fixed`，因此子代理的模型由用户掌控，只有按角色显式启用 `automatic` 才会让该角色参与由代理选择的路由。给出路由的 `fixed` 角色会精确固定该路由：路由把它作为子代理的 agent options 发送，并拒绝任何给出路由字段的调用。未给出路由的 `fixed` 角色不贡献任何路由，因此子代理继承调用父代理解析出的路由，而父代理仍无法更改它。`automatic` 角色接受可选的 `provider`、`model` 与 `reasoning_effort`，且仅接受 `automaticRouting.allowedModels` 中的值；既有的选择路径会把请求合并到角色自身的路由之上，以 `child LLM route "<provider>/<model>" is not allowed for this Session` 拒绝未授权的路由，并在任何子代理存在之前通过实时 LLM 运行时解析出有效路由。在未给出推理强度的情况下更换路由会丢弃已配置的推理强度，因为该推理强度属于被替换掉的那条路由。

### 工作区覆盖

`overrides` 以会话 `cwd` 经 `path.resolve` 得到的规范工作区路径为键（Windows 下转为小写）。条目是对全局角色的字段补丁：未提及的字段一律继承，提及的字段一律替换，`removed` 列表只为该工作区移除某个角色。只提及路由一半的补丁，是对整个路由字段的补丁。

### 后台运行

后台委派同步注册其作业，并在准入之前返回作业 id，因此调用方绝不会因为前一次运行尚未结束而被阻塞。此后由该作业拥有并发名额、运行与拆除：杀死尚未被准入的作业不会占用名额，杀死正在运行的作业会归还它持有的名额。子代理文本可在作业结算后通过作业自身的输出读取。

### 失败与恢复

每一次拒绝都是响亮的，并指明原因：未知 id 会列出已配置的 id，被禁用的角色会按名拒绝，无人注册的后端会在咨询审批通道之前就报告出来，授权范围之外的路由会以共享的选择错误拒绝，而无法限制子代理的后端会拒绝具体的访问级别，而不是忽略它。没有回退，也没有静默降级。

### 迁移

用户此前配置过名册之前的命名空间的部署会保留这些配置。在首次发现已存 `commandcode-delegation` 通道的加载中，插件会把它们——连同按工作区的 `projects` 覆盖层、运行上限与 `subagent-model-selection` 授权——投影进 `subagent-roster` 文档，校验后一次性写入。

该写入是叠加式的：`commandcode-delegation`、其 `projects` 覆盖层与 `subagent-model-selection` 都原样保留，因此旧值仍可查看，用户也可以通过编辑新文档回退。已存的 `subagent-roster` 分区会终止迁移，即使用户清空了其中的角色列表，因此用户编辑过的角色目录绝不会被替换。若已存的旧值投影出的文档无效，则以一条警告拒绝写入，并保留内置角色。

每个被迁移的角色都保留 `commandcode` 后端，因此在有人以该名称注册提供者之前，对它们的委派会响亮失败。

### Remote 接口

本插件拥有生成的 `subagentRoster` Remote 命名空间，浏览器界面读取的正是它。每个方法只返回角色策略与运行上限：任何凭据、提供方令牌、主机路径或进程输出都不会经过它。

| 方法 | 返回值 |
|---|---|
| `resolvedRoster(workspace, signal)` | 某个工作区已启用的角色——`name`、`purpose`、`whenToUse`、`invocation`、已解析的 `model` 策略、`access` 与 `execution`——每个角色都带有逐字段的覆盖来源信息，以及它们所解析出的规范工作区键。该工作区禁用或移除的角色不会出现 |
| `automaticRouting(signal)` | 是否接受显式路由选择，以及显式选择必须解析到的精确 `{ provider, model }` 路由 |
| `storedRoster(signal)` | 配置界面所编辑的已存文档：全部定义（无论是否启用）以及运行上限 |

每次读取解析的都是两个面向模型的工具所读取的同一个实时设置分区，因此界面与下一次委派不会对某次已保存的修改产生分歧；`workspace: null` 只解析全局层。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

### 设计要点

- **角色是策略，不是参数。** 模型只需给出角色名；角色决定模型、强度、访问级别、调用策略与后端。工具 schema 没有可以放宽其中任何一项的字段。
- **调用时读取。** 设置文档（因而目录、路由授权与运行上限）在每次委派时都会读取，因此保存的修改无需重新组合即可作用于下一次调用。
- **单一运行闸门。** 前台调用与后台作业从同一个限流器取得名额，而其上限在每次准入时读取。
- **收窄由接缝拥有。** 子代理的模式在 `@deepseek-ai/dsh-subagent` 内部、通过与提权检查同一套阶梯收窄；本包只贡献所请求的访问级别，不涉及它如何被应用。

### 源码导图

| 文件 | 作用 |
|---|---|
| [`src/index.ts`](src/index.ts) | 服务入口：设置注册、运行限流器与两个工具 |
| [`src/settings.ts`](src/settings.ts) | 命名空间、schema、工作区规范化与按工作区解析 |
| [`src/types.ts`](src/types.ts) | 存储态、解析态与目录条目的词表 |
| [`src/defaults.ts`](src/defaults.ts) | 内置角色、路由默认值与运行上限 |
| [`src/directory.ts`](src/directory.ts) | 模型可见的目录投影及其渲染文本 |
| [`src/tools.ts`](src/tools.ts) | `list_subagents`、`delegate`、路由解析与调用策略 |
| [`src/authority.ts`](src/authority.ts) | 打开回合的授权窗口与直接人类检查 |
| [`src/limiter.ts`](src/limiter.ts) | 共享并发闸门 |
| [`src/migrate.ts`](src/migrate.ts) | 从名册之前的命名空间进行的投影 |
| [`src/migration.ts`](src/migration.ts) | 读取旧命名空间并一次性写入投影文档的加载时迁移 |

### 运行流程

一次调用会解析调用会话的工作区，要求模型给出的 id 对应一个已启用角色，解析后端提供者，并执行该角色的调用策略。随后在任何子代理存在之前解析子代理的路由——角色固定的路由、父代理经授权的选择，或在子代理继承时干脆没有路由。前台调用取得运行闸门名额，以角色的 persona、工具作用域、深度上限与所请求的访问级别启动子代理，并返回其最终文本。后台调用先注册作业，交由该作业自身的任务取得名额、启动子代理并结算。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [子代理子系统](../../../docs/subsystems/subagent.zh.md) —— 本插件组合使用的共享委派契约。
- [dsh-subagent](../subagent/README.zh.md) —— 本包所使用的访问收窄与提供者注册表接缝。
- [tool-subagent](../tool-subagent/README.zh.md) —— 本包复用其模型选择模块的按后端委派面。
- [dsh-subagent-commandcode](../subagent-commandcode/README.zh.md) —— `src/migrate.ts` 所投影的通道系统存储文档。
- [生成的配置目录](../../../docs/config-catalog.zh.md) —— 每个可接受的配置字段及其源声明。

-----

<a id="model-experience"></a>
## 模型体验

### 子代理发现

#### 模型看到什么

`list_subagents` 不接受参数，并为调用会话所在工作区已启用的每个角色报告一行：`id`、`name`、`purpose`、`whenToUse`、`invocation`、解析后的 `model`（精确的 `provider/model` 对及其 `reasoningEffort`，或 `inherit`）、`access` 与 `background`。被禁用的角色以及本工作区移除的角色不会出现。它不报告指令、不报告设置文档，也不报告其他任何包的数据。渲染结果是每个角色一行，因此路由指引与 `delegate` 所接受的 id 出现在同一次调用中。

#### Token 影响

每次调用产生一个结果，大小与已启用角色的数量成正比：每个角色一行渲染文本，包含其 `purpose` 与 `whenToUse`。

#### KV 缓存影响

仅追加：结果位于可复用的前缀之后。

### 委派

#### 模型看到什么

`delegate` 接受必填的 `subagent` id、必填的自包含 `task`、可选的 `run_in_background`，以及仅 `automatic` 角色会接受的可选 `provider`、`model` 与 `reasoning_effort` 字段。它不暴露任何访问、沙箱、权限、凭据、超时或轮数字段，而 `fixed` 角色会直接拒绝每一个路由字段。前台调用返回子代理的最终文本，或以该运行的结果细节失败。后台调用返回作业 id，供 `job_output` 与 `job_kill` 使用，并由作业运行时投递完成通知。子代理的记录、工具流量与推理都不会进入父会话。

#### Token 影响

前台调用会增加子代理的最终文本，或未完成运行的结果细节。后台调用会增加启动确认、完成通知，以及 `job_output` 返回的任何内容。

#### KV 缓存影响

仅追加：结果位于可复用前缀之后，完成通知可能增加一个回合，但不会重写该前缀。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- **一个静态 schema 同时服务两种模型模式** —— `delegate` 为每个角色声明路由字段，因为一个已注册的工具服务整个目录；`fixed` 角色在执行时而非 schema 上拒绝它们。若要隐藏它们，需要在设置文档每次变化时重新注册该工具。
- **无法收窄访问的后端会拒绝具体访问级别** —— 进程外提供者声明 `accessPolicy: false`，因此在它上面要求 `read-only` 的角色会在启动时响亮失败，而不是不受限制地运行；这类角色需要进程内后端。
- **本包中没有该设置分区的客户端页面** —— 文档通过设置服务编辑；子代理页面属于另一个插件。
- **工作区覆盖以单一解析路径为键** —— 规范键是 `path.resolve(workspace)`（Windows 下转为小写），因此以另一种拼写或符号链接到达的同一工作区属于不同的键。
- **启用自动路由必须指定路由** —— 在未给出任何允许模型的情况下开启选择，会在设置写入时被拒绝，而不是在下一次委派时。
- **角色 id 一经创建便固定** —— id 既是模型可见的名称，也是覆盖键，因此重命名角色意味着新增一个并移除另一个。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>面向维护者的工作上下文——点击展开</summary>

- **收窄阶梯位于接缝中** —— `@deepseek-ai/dsh-subagent` 由父代理的有效模式与所请求的访问级别解析出子代理模式，因此本包从不重新实现 `sandbox/src/escalation.ts` 所编码的次序。
- **路由路径是共享的那一条** —— `requestedAgentOptions`、`assertAllowedModelSelection` 与 `preflightChildLlmRoute` 与 `tool-subagent` 使用的是同一批函数，因此授权与能力规则不会在两个面之间漂移。
- **迁移把投影与写入分开** —— `src/migrate.ts` 构建新文档且不改动它收到的任何内容；`src/migration.ts` 通过设置服务读取两个命名空间、校验投影出的文档并一次性写入，同时保持两个旧分区不变。

</details>

**Runtime invariant:** 不发布伴随文件。角色目录及其运行上限由设置服务拥有，子代理策略由委派接缝拥有，本包不持有任何第二次观测可能与之矛盾的状​​态。
