---
description: "Harnessy 的 Command Code 委派插件：面向配置通道、运行上限与工作区覆盖的运维者和维护者，以及选择通道进行委派的模型。"
kind: "package-reference"
---

# @deepseek-ai/dsh-subagent-commandcode

[English](README.md) | 中文

## 概述

当 Harnessy 会话需要把自包含的任务委派给用户自己安装的 Command Code CLI 时，挂载此插件。它注册一个实时设置命名空间（拥有通道目录与三项运行上限）、两个 token 稳定的模型可见工具（`list_commandcode_lanes` 与 `commandcode_delegate`），以及子代理设置页面读取的 `commandcode` Remote 命名空间。通道属于用户数据：每个通道固定了精确模型、推理强度与访问级别，因此被委派的任务无法选择或提升其中任何一项。插件还会为花名册角色在 `ctx.subagents` 上注册 `commandcode` 后端，并且加载时不会启动任何 Command Code 进程。

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

在配置档中挂载 Host 行。在本仓库中，该行由 `custom-harness` 产品补丁层拥有，因此只有 Harnessy 获得此功能，其他配置档不会出现 Command Code 路径。

```yaml
- id: commandcode-delegation
  name: '@deepseek-ai/dsh-subagent-commandcode'
```

### 前置条件

CLI 由用户自行提供。本包不会内置、安装或再分发 Command Code，也不会读取、复制或保存其凭据。用户自行安装 CLI、登录，并在设置中选择通道。

| 平台 | 本构建调用的可执行文件 |
|---|---|
| Windows | `cmdc` |
| 其他 | `cmd` |

在 Windows 上，本构建会读取 npm shim 所启动的 JavaScript 入口，并用当前 Node 可执行文件运行该入口；共享的子进程接缝直接以 argv 启动进程，从不经过 shell。

### 配置

| 字段 | 默认值 | 含义 |
|---|---|---|
| `disposeGraceMs` | `3000` | 共享受管范围终止层级之间的宽限时间 |

用户在运行时调整的一切都位于 `commandcode-delegation` 设置分区，而不是组合配置中，因此修改会对现有会话的下一次委派立即生效。

| 字段 | 默认值 | 含义 |
|---|---|---|
| `maxConcurrentRuns` | `2` | 允许同时运行的 Command Code 运行数，前台与后台一并计算（1–16） |
| `timeoutMs` | `3600000` | 单次运行的墙钟上限（不超过 `MAX_TIMER_DELAY_MS`） |
| `maxTurns` | `60` | 传给 CLI `--max-turns` 的轮数上限（1–1000） |
| `lanes` | `code`、`review`、`tests`、`docs`、`research`、`architecture` | 存储的通道目录 |
| `projects` | `{}` | 以规范工作区路径为键的按工作区通道覆盖 |

每个存储的通道包含 `id`、显示名 `name`、一行 `purpose`、可选的 `instructions`、精确 `model`、取值为 `default`、`low`、`medium`、`high` 的 `effort`、取值为 `read-only` 或 `full-access` 的 `access`，以及 `enabled` 标志。所有内置通道都从 `deepseek/deepseek-v4.1-flash` 开始；`code`、`tests`、`docs` 默认为 `full-access`，而 `review`、`research`、`architecture` 默认为 `read-only`。

### 访问级别

完全访问会以 `--yolo` 运行 CLI，使其可在工作区中不经询问地修改文件并执行命令。只读会省略 `--yolo` 并传入 `--permission-mode plan`，从而保持 CLI 原生的只读行为。只有存储的通道能在两者之间选择；模型只提供通道 id，不提供其他任何内容。

### 子代理后端

插件在 `ctx.subagents` 上以固定名称 `commandcode` 注册一个提供方，因此 `execution.backend` 为 `commandcode` 的花名册角色会通过该 CLI 运行。名称固定是因为存储的角色会引用它：花名册会把此前存储的每个通道投射到该后端，因此改名会让那些角色失去后端。

后端从 `agentOptions` 读取角色路由：模型 id 原样传入 `--model`，推理强度原样传入 `--effort`，因此它接受的目录是 CLI 自身的，而不是 `ctx.llm` 的。未命名路由的角色不传 `--model`，由 CLI 应用自身配置的默认值；CLI 不接受的强度会拒绝启动。访问级别映射到与通道相同的两种权限模式，而要求 CLI 无法表达的级别 —— `workspace-write` —— 的角色会在启动时被拒绝，而不是被归入另一种级别。角色指令加在任务书之前，轮数上限与墙钟上限来自上文的设置分区。

后端只发布 `agentOptions`、`persona` 与 `accessPolicy`，不发布其他任何能力：CLI 子进程拥有自己的工具、委派深度与结构化输出，因此在此后端上要求工具过滤或深度上限的角色会在启动时被拒绝。

### 工作区覆盖

`projects` 以规范工作区路径为键。覆盖条目是对全局通道的字段补丁：未提及的字段一律继承，提及的字段一律替换。没有工作区的会话直接使用全局通道。删除通道时也会删除所有针对它的覆盖，因此之后复用该 id 的通道不会继承陈旧的补丁。

### 后台运行

未设置 `run_in_background: false` 的调用会同步注册其作业，并在任何探测或准入之前就返回作业 id。此后由该作业拥有 CLI 预检、并发名额、进程与拆除，因此调用方绝不会因为前一次运行尚未结束或探测仍在进行而被阻塞。

杀死仍在探测或等待名额的作业会以 killed 结算：它不会启动任何 Command Code 进程，并归还它已持有的名额；若尚未被准入，则根本不会占用名额。杀死正在运行的作业会先终止其进程树，再让作业结算。从未进入运行的委派会以失败作业结算，其 detail 与失败运行使用同一套固定的产品自有诊断 —— 绝不会包含主机路径、命令或原始产品错误。

`job_output` 返回的内容与同一次调用在前台会返回的内容一致。运行期间它只报告当前的粗粒度活动 —— 思考、读取、编辑、执行命令、收尾 —— 除此之外不报告任何内容。结算之后它报告该运行有界的最终答案；若运行失败，则报告产品自有的诊断，连同 CLI 已经产生的任何部分答案。被杀死作业不报告答案，因为被取消的委派本来就没有答案。

### 健康检查与模型目录

安装状态、版本与登录状态会在子代理设置页面请求时读取，并在每次委派运行前再次读取；加载插件与加载工具都不会启动任何进程。并发的探测会被合并而不是重复发起。通道始终接受手动输入的精确模型 id，而子代理设置页面会读取 CLI 的 `--list-models` 目录以提供其路由，因为目录成员关系仅供参考，原生执行才是权威。

### 逐模型推理等级

Command Code 的 `--list-models` 列表只带 id 与描述，其 `--effort` 标志也只是一套固定词汇；两者都没有说明某个模型实际接受哪些等级。逐模型的答案来自 CLI 自带、并用于校验其自身 `model:effort` 简写的目录——即已安装入口点旁边的 `bundled/command-code-knowledge/reference/models.md`，其 `Efforts` 列为它服务的每个 id 列出等级集合，并用破折号表示由模型自行决定推理深度的那些模型。插件会读取该目录，并通过 `ctx.llm.registerModelCapabilitySource` 发布为模型发现可采纳的逐模型能力，因此 `deepseek/deepseek-v4-pro` 只提供 `high` 与 `max`，而 `Qwen/Qwen3.8-Flash` 提供 `low`、`medium` 与 `xhigh`。目录在首次查询时才从已安装入口点解析，因此挂载插件不会触碰任何文件。该来源只为命名了 Command Code 或指向 `commandcode.ai` 端点的路由作答，因为目录仅以模型 id 为键，而 Command Code 也为其他厂商的模型提供裸 id；目录缺失、被移动或改版时则完全不作答，从而让每个模型保持未声明，而不是提供无人声明过的等级集合。

### 失败与恢复

没有回退。当 CLI 缺失、未登录，或报告通道的模型、访问级别或账户状态不可用时，委派会以有界的、产品自有的诊断失败，指明原因与进程结果，且不会尝试其他任何方式。被取消的运行会以 `aborted` 结算；超出通道超时的运行会被终止，并以指明时间上限的失败结算。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

### 设计要点

- **通道是策略，不是参数。** 模型只需给出通道名；通道决定模型、推理强度与访问级别。调用无法扩大其中任何一项，两个工具 schema 也没有可扩大的字段。
- **调用时读取。** 上限与通道在每次委派时都从实时设置命名空间读取，因此保存的修改无需重启即可作用于下一次运行。
- **每项事务单一所有者。** 共享子进程服务拥有进程树，通用作业注册表拥有调度与完成通知，本包只拥有 Command Code 自身的生命周期决策。
- **在源头限定并净化。** 父会话只会看到已经通过 12 KiB UTF-8 上限的文本，以及固定的失败事实；原始 stderr 尾部保留在 Host 上。

### 源码导图

| 文件 | 作用 |
|---|---|
| [`src/index.ts`](src/index.ts) | 服务入口：设置注册、Remote 命名空间、探测记忆化 |
| [`src/tools.ts`](src/tools.ts) | 两个模型可见工具，以及前台适配 |
| [`src/backend.ts`](src/backend.ts) | `ctx.subagents` 上的 `commandcode` 提供方：路由、访问级别与生命周期适配 |
| [`src/job.ts`](src/job.ts) | 后台适配：一个作业，其任务拥有预检、准入、启动与拆除 |
| [`src/settings.ts`](src/settings.ts) | 命名空间名称、schema，以及单个工作区的通道解析 |
| [`src/lanes.ts`](src/lanes.ts) | 内置通道、工作区键与任务书组装 |
| [`src/cli.ts`](src/cli.ts) | 可执行文件解析、健康探测与目录解析 |
| [`src/argv.ts`](src/argv.ts) | CLI 调用，任务书经 stdin 传入 |
| [`src/protocol.ts`](src/protocol.ts) | 增量 NDJSON 读取、活动状态与退出码 |
| [`src/run.ts`](src/run.ts) | 一次性生命周期、超时、取消、拆除 |
| [`src/limiter.ts`](src/limiter.ts) | 共享并发闸门 |
| [`src/bound.ts`](src/bound.ts) | 父会话可见字节上限 |

### 运行流程

一次调用会解析当前工作区的通道，要求给出已启用的通道 id，并用通道指令与任务组装任务书。前台调用随后等待 CLI 预检与并发名额，以该通道的标志启动 CLI，并把任务书写入 stdin，然后逐行读取 NDJSON 流。后台调用则改为注册一个作业，其启动函数执行同样的序列，因此注册立即返回 id，只有该作业自身的任务会去探测、等待、启动并拆除。只有 subtype 为 `success` 且 `finalText` 非空的 `result` 帧才算完成一次运行；其他所有终止状态、没有结果帧的截断、没有结果帧的非零退出码以及缺失的进程结果，都会在观察到进程确实结束之后变成有界的失败。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [委派子系统](../../../docs/subsystems/subagent.zh.md) —— 本功能复用的共享委派契约。
- [dsh-subagent](../subagent/README.zh.md) —— 本包组合使用的进程外接缝。
- [Harnessy 产品补丁层](../../bundle/custom-harness/README.zh.md) —— 挂载本插件及其设置分区的配置档。
- [子代理设置页面](../../client/ui-settings-subagents/README.zh.md) —— 编辑该配置所迁移到的角色目录的设置界面。
- [生成的配置目录](../../../docs/config-catalog.zh.md) —— 每个可接受的配置字段及其源声明。

-----

<a id="model-experience"></a>
## 模型体验

### 通道发现

#### 模型看到什么

`list_commandcode_lanes` 报告当前工作区已解析的启用通道：每个通道的 `id`、`name`、`purpose`、精确 `model`、`effort` 与 `access`。它不报告指令、路径、无关设置或 CLI 目录的任何部分。

#### Token 影响

每次调用产生一个小结果，大小与已启用通道的数量成正比。

#### KV 缓存影响

仅追加：结果位于可复用的前缀之后。

### 委派

#### 模型看到什么

`commandcode_delegate` 接受必填的通道 id、自包含的任务，以及可选的 `run_in_background`。它不暴露任何模型、强度、超时、轮数、可执行文件、凭据或权限字段。后台调用返回作业 id；通用作业运行时随后投递完成通知，`job_output` 承载的正是同一次调用在前台会返回的内容：有界的最终答案，或失败运行的诊断与保留的部分答案。前台调用直接返回该文本。失败的运行会返回有界的、产品自有的诊断，指明原因与进程结果，以及 CLI 已经产生的任何部分答案。Command Code 的推理、工具流量、命令、文件内容、原始 stderr、原生会话 id 与完整记录都不会进入父会话。

#### Token 影响

前台输入增加保留的最终答案或失败诊断，两者都限定在 12 KiB。后台输入还会携带启动确认、完成通知以及任何 `job_output` 或 `job_kill` 结果。

#### KV 缓存影响

仅追加：结果位于可复用前缀之后，后台完成通知可能增加一个回合，但不会重写该前缀。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- **任务书经 stdin 而非 argv 传入** —— `-p` 不带查询参数是 CLI 文档化的管道输入形式，因此任务文本不会进入命令行；CLI 自身 30 秒的 stdin 超时仍会限制该写入的最晚到达时间。
- **没有续接或恢复** —— 每次委派都是一次全新的一次性运行；CLI 以 `--no-session` 调用，Harnessy 只保留当前会话的作业历史。
- **目录解析仅供参考** —— `--list-models` 按形状读取而非固定 schema；格式变化后的列表不会产生任何行，设置页面转而要求输入精确模型 id。
- **Windows 解析依赖 npm shim** —— 若某个 Windows 安装的 `cmdc.cmd` 未指明 JavaScript 入口，会被报告为不可用，而不是被绕过。
- **按设计没有按调用覆盖** —— 需要不同模型、强度或访问级别的任务需要另一个通道；没有可调用的旁路。
- **角色的访问词表比 CLI 更宽** —— CLI 只表达只读与完全访问，因此指定 `workspace-write` 的 `commandcode` 角色会在启动时被拒绝，而不是被近似处理。
- **只有一种 CLI 实现** —— 插件只与用户安装的 Command Code 通信；没有替代后端，缺失时也没有回退。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>面向维护者的工作上下文——点击展开</summary>

- **标志面来自已安装的 CLI** —— 调用方式、退出码词表与 JSON 输出形状均来自 Command Code 1.54.0 自身的 `--help` 与内置的无头参考文档；未来版本若改变它们，需要重新按同样方式推导，而不是猜测。
- **访问级别是通道字段而非调用字段** —— 两个 schema 保持 token 稳定的原因正是：扩大调用无法扩大权限。

</details>

**Runtime invariant:** 不发布伴随文件。进程树所有权属于共享子进程服务，调度与完成通知属于通用作业注册表，设置文档由设置服务拥有。
