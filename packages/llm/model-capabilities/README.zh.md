---
description: "面向维护者的公开模型能力发现：把具备提供方感知的推理强度元数据接入模型发现。"
kind: "package-reference"
---

# @deepseek-ai/dsh-model-capabilities

[English](README.md) | 中文

## 概述

`@deepseek-ai/dsh-model-capabilities` 解析公开模型数据库对某条已配置路由所作的陈述，以及该陈述可以被信任到何种程度。挂载 `model-capabilities` 插件后，它为每个公开数据库各保留一份目录——成功抓取的结果，否则是持久缓存，再否则是随包快照——并在 `LlmRuntime` 上注册唯一一个能力来源，因此未声明的模型会以其自身的提供方感知公开声明被回答，而仅凭模型 id 的声明始终是无人会自动采用的建议。刷新在配置控制下于后台进行，因此无论公开端点是否可达，模型发现都能工作。

## 目录

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

当部署希望为任何适配器或本地集成都未描述的模型提供推理强度控件时，就使用这个包。

### Mount the plugin

```yaml
- name: '@deepseek-ai/dsh-llm'
- name: '@deepseek-ai/dsh-model-capabilities'
  config:
    publicMetadata:
      enabled: true
      refresh: auto
      cacheTtl: 7d
```

它必须挂载在 `@deepseek-ai/dsh-llm` 之后，因为该服务是必需的。设置接缝是可选的：挂载 `@deepseek-ai/dsh-settings` 时，用户 `settings.yaml` 会覆盖该行；不挂载时，该行就是全部配置。

同时挂载 `@deepseek-ai/dsh-subagent-commandcode` 的组合，必须把该行声明为注入的服务，因为补丁文件中的行位置并不决定两者的先后：

```yaml
- id: model-capabilities
  name: '@deepseek-ai/dsh-model-capabilities/plugin'
  inject: [commandCodeController]
```

Loader 会并行挂载同级行，因此文件中的位置不决定任何顺序；LLM 接缝按注册顺序询问能力来源且先答者胜，只有声明依赖才能让 Command Code 自己的来源先注册。这正是让它的声明优先于任何公开主张的机制。

### Inspect and sync from the command line

挂载 `@deepseek-ai/dsh-model-capabilities/cli`（它注入上面的 store）会为该应用自己的命令行加入三个开关：

```sh
dsh --profile custom-harness --models-sync=check
dsh --profile custom-harness --models-sync=write
dsh --profile custom-harness --models-explain=openai-codex/gpt-5.6-sol
dsh --profile custom-harness --models-sync=check --models-refresh
```

`check` 报告每个已配置模型以及同步会采取的动作，且不修改任何内容。`write` 只持久化按提供方匹配解析出的行，其余每一行保持逐字节不变。`explain` 打印某一个按路由限定的模型的完整链路——每个公开层级、作答的提供方条目，以及最终等级或那些被拒绝的建议。

模型参数是 `<route>/<model>`，绝不是裸 id：同一个模型经由不同网关可能解析出不同结果，甚至完全无法解析，而裸 id 正是本层拒绝猜测的那种歧义。两个开关都可重复，并按 argv 顺序执行，因此一次调用可以先写入同步再检查它留下了什么。

### Configure it

插件拥有 `model-capabilities` 设置命名空间，因此同样的取值也可以在设置文档中以 `model-capabilities.publicMetadata` 配置：

| Field | Default | Meaning |
|---|---|---|
| `enabled` | `true` | 公开元数据层是否运行。`false` 时不应用任何公开目录——随包的、缓存的与实时的都不应用——因此所有公开主张都被关闭，也不会发出任何请求。 |
| `refresh` | `auto` | `auto` 抓取缺失或已过期者；`manual` 绝不自行抓取；`never` 直接拒绝网络访问。 |
| `cacheTtl` | `7d` | 已抓取目录保持新鲜多久。正整数加一个单位：`ms`、`s`、`m`、`h` 或 `d`。 |

`manual` 与 `never` 提供的目录完全相同——有缓存就用缓存，否则用随包快照——两者只在于显式命令是否可以抓取：`manual` 允许 `--models-refresh` 请求，`never` 则拒绝它。本语法无法读取的 `cacheTtl` 会在写入处被拒绝，而不是变成一个永不运行的刷新。

### What each setting does

- **`enabled: false`** —— 该层不提供任何目录，因此发现会让每个未声明模型保持未声明，且绝不联系公开网络。适配器原生与本地集成的答案不受影响，而 `--models-sync` 调用会报告该层已禁用，而不是绕过策略。
- **`refresh: auto`** —— 有效缓存原样提供；缺失或过期者在后台刷新。启动绝不等待该抓取。
- **`refresh: manual`** —— 缓存目录无论多旧都照常提供；不会自动抓取任何内容，而 `--models-refresh` 是唯一会抓取的路径。
- **`refresh: never`** —— 提供方式相同，且绝不发出请求；`--models-refresh` 调用会以失败被拒绝，而不是悄悄报告陈旧数据。

### What `write` will not do

同步只持久化按提供方匹配解析出、且该行未声明任何内容的结果。它绝不覆盖显式声明，绝不在互相矛盾的仅凭模型 id 的主张之间做选择，绝不写入未解析的模型，也绝不臆造等级。写入是通过设置接缝的一次校验过的合并，因此无关配置与无关行都能存活；当没有任何可写入项时，接缝根本不会被调用。

### Build the capability source yourself

拥有自有目录来源的组合可以跳过插件而直接注册。`origin` 说明每个目录的来源——`fixture`、`bundled`、`live` 或 `cache`——并进入每个答案的来源信息。

```ts
import type { Context } from '@deepseek-ai/cordis'
import {
  createPublicCapabilitySource,
  loadBundledPublicCatalogs,
} from '@deepseek-ai/dsh-model-capabilities'
import type { PublicCatalog } from '@deepseek-ai/dsh-model-capabilities'

declare const ctx: Context
declare const modelsDev: unknown
declare const openRouter: unknown

// Most authoritative first; the layer never merges two sources into one answer.
const catalogs: readonly PublicCatalog[] = [
  { source: 'openrouter', origin: 'live', fetchedAt: new Date().toISOString(), entries: openRouter },
  { source: 'models.dev', origin: 'live', fetchedAt: new Date().toISOString(), entries: modelsDev },
  ...loadBundledPublicCatalogs(),
]

const dispose = ctx.llm.registerModelCapabilitySource(
  'public-metadata',
  createPublicCapabilitySource(catalogs),
)
```

`loadBundledPublicCatalogs()` 读取随包快照一次、校验它，并按优先级顺序返回两个目录，各自标记为 `origin: 'bundled'`。

### Regenerate the bundled snapshot

```sh
pnpm run gen-model-capability-snapshot          # rewrite the artifact
pnpm run verify-model-capability-snapshot       # fail if it is stale (in doc-sync)
```

生成器读取 `tests/fixtures/upstream/` 中的精选捕获，而这些捕获由 `.artifacts/make-snapshot-fixtures.mjs` 从完整的公开捕获派生。两条命令都离线运行。`--check` 复用已提交的时间戳，因此门禁只会因内容失败，绝不会因墙上时钟失败；`--models-dev`、`--openrouter`、`--out` 与 `--generated-at` 可覆盖其输入。

### Resolve without registering

`resolvePublicCapability(catalogs, modelId, request)` 返回的答案与来源所回答的相同，另外还给出该来源刻意不提供的来源信息与建议。诊断界面用它来解释整条链路：`resolved` 结果会指出匹配到的提供方条目及其匹配方式，`unresolved` 结果则携带它转而找到的那些仅凭模型 id 的声明。

### What the answer may be

| `kind` | Meaning | May be declared |
|---|---|---|
| `resolved` | 提供方感知的匹配：该路由自身的端点或 id 命名了一个发布此模型的提供方条目。 | Yes |
| `unresolved` | 没有提供方感知的匹配。`suggestions` 保存每一条仅凭模型 id 的声明，每个提供方条目一条，并标注为 `model-id-only` 或 `model-id-ambiguous`。 | No |

当且仅当某条路由配置的端点位于 `openrouter.ai` 主机上，或其路由 id 命名了 OpenRouter，它才属于 OpenRouter 自己；只有这时 OpenRouter 的目录才会作答，因此暴露同一模型 id 的无关网关绝不会继承 OpenRouter 的等级。

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Design philosophy

匹配依据路由身份，绝不依据模型 id。模型 id 并不标识网关，而网关才决定存在哪些推理控件：`gpt-5.6-sol` 经由一个 models.dev 提供方条目发布 `none,low,medium,high,xhigh,max`，经由另一个发布 `low,medium,high,xhigh`。因此仅凭 id 的声明绝不会成为能力；它会连同其竞争者一并报告，交由人来决定。

### Source map

| File | Role |
|---|---|
| [`src/types.ts`](src/types.ts) | 目录、匹配、来源信息与解析结果的词汇 |
| [`src/routes.ts`](src/routes.ts) | 端点与提供方 id 的规范化，包括 OpenRouter 路由判定 |
| [`src/efforts.ts`](src/efforts.ts) | 把公开强度词元转换为 harness 的等级词汇 |
| [`src/resolve.ts`](src/resolve.ts) | `resolvePublicCapability`、两个数据库读取器，以及 `createPublicCapabilitySource` |
| [`src/snapshot.ts`](src/snapshot.ts) | 精选、随包文档 schema 及其校验 |
| [`src/snapshot/public-model-capabilities.ts`](src/snapshot/public-model-capabilities.ts) | 生成出的产物本身 |
| [`src/bundled.ts`](src/bundled.ts) | `loadBundledPublicCatalogs()` 与 `bundledSnapshotMetadata` |
| [`src/fetch.ts`](src/fetch.ts) | 两次公开 GET、其体积上限与响应校验 |
| [`src/cache.ts`](src/cache.ts) | 持久缓存文件及其原子替换 |
| [`src/store.ts`](src/store.ts) | 目录选择、TTL 判定与单轮刷新 |
| [`src/config.ts`](src/config.ts) | `model-capabilities` 段落 schema 及其时长语法 |
| [`src/plugin.ts`](src/plugin.ts) | 组合行：注册、后台刷新与销毁 |
| [`src/inspect.ts`](src/inspect.ts) | 某个按路由限定的模型解析出什么，以及同步会对它做什么 |
| [`src/cli.ts`](src/cli.ts) | `--models-sync` 与 `--models-explain` 命令 |

### Catalog selection

每个数据库一份目录，绝不合并：最新成功抓取的结果，否则是无论多旧的最后已知良好缓存，再否则是随包快照。各层级是有序而非合并的，因为把同一数据库的两个世代并列会给出两代都未声明过的等级。

年龄不等于有效性。超过 TTL 的缓存条目只是*有资格刷新*，并不会被丢弃：它会持续作答，直到某次抓取真正替换它，这正是让失败的刷新对组合器不可见的机制。只有结构性无效的条目——数据库不对、抓取时间不可读、目录为空——才会被丢弃，而且只丢弃本构建无法读取的那些条目，绝不丢弃整个文件。

TTL 按数据库分别判定，因为两者可以各自独立地成功或失败；边界属于“陈旧”一侧：恰好达到 `cacheTtl` 的条目有资格刷新，而年轻一毫秒的则没有。时钟是注入的，因此每个边界情形都无需等待即可测试。

### Refresh and failure

单轮刷新只询问缺失或已过期的数据库，让两次抓取各自独立结算，并把成功者以一次原子写入提交。失败会保留该数据库先前的目录，并按数据库分别上报；畸形响应被整份拒绝，因此代理错误页面绝不可能用空目录替换已知良好的缓存。缓存写入失败只损失持久性——目录已在内存中生效，因此发现会继续供给。

刷新是带归属者的后台工作：插件持有其 abort 控制器，用截止时间限制它，并在销毁时中止它。启动不等待任何网络操作，因此不可达的端点不会延迟任何发现——首个答案无论如何都来自缓存或快照。

### Reading the databases

`models.dev` 发布 `reasoning_options`，即一组控件描述符，其中 `type: 'effort'` 的那一项携带 `values`。OpenRouter 为每个模型发布 `reasoning.supported_efforts` 与 `reasoning.default_effort`。两个读取器都会校验它们所读取的成员并跳过其余内容，因此格式错误的提供方或模型条目等于什么也没说，而不会让查询失败。已抓取的响应会经过快照生成器自身的精选流程，因此实时目录与随包产物是对同一发布形态的同一种缩减。

### Inspecting and syncing

命令从设置接缝读出路由，并为每个已配置模型向 `inspect.ts` 问一个问题，因此 CLI 自己不做任何匹配：答案就是 store 自身的选目录结果，经过运行时接缝所用的同一个 `resolvePublicCapability`。`explain` 渲染已报告的那条链路，而不是重建一条。

命令据以行动的每行只有一个判定：某行未声明任何内容、且按提供方匹配解析成功，判定为 `write`；已声明等级集或直接拒绝推理的行判定为 `declared`；仅凭 id 的主张判定为 `suggestion`；其余一切判定为 `unresolved`。`check` 打印该判定，`write` 只对 `write` 行采取行动。

写入是通过设置接缝的一次 `llm-pi-ai` 合并。接缝会整体替换数组，因此被触及的路由会贡献其完整模型列表，只有匹配的行发生变化——其余每一行的每个字段都按原样重述，这正是让写入不会丢掉它本无意触及的配置的机制。当没有任何可写入项时，接缝根本不会被调用，因此对一个已完全声明的部署执行 `write` 会让文档逐字节不变。

### What the Models page reads

挂载插件的同时也会挂载 `ModelCapabilitiesInspector`，它提供 `modelCapabilities/inspect` Remote。它为每个已配置模型返回一份投影——`enabled`、实际生效的按提供方匹配，以及不生效的仅 id 主张——由运行时接缝与命令行所用的同一套“已配置路由”联接与同一个解析器构建。Client 通过 `@deepseek-ai/dsh-api-remotes` 渲染它，因此没有任何浏览器包导入本包，也不存在第二个匹配器。

该投影有意省略该行自身的声明：界面在草稿中编辑它，因此 Host 的那份副本只会在编辑与提交之间变成陈旧值。它同样省略路由的设置字段与同步判定，界面用不到它们。保留 `enabled` 是因为禁用的层与“数据库没有该模型记录”都会解析出空结果，而界面必须区分二者才能说明发生了什么。

store 只被读取、绝不被加载：界面报告运行时此刻正在作答的内容，而缓存读取属于拥有启动的那一层。

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [dsh-llm service](../llm/README.zh.md) —— `registerModelCapabilitySource`、`LlmDiscoveredModel`，以及每个声明都要经过的唯一一次规范化。
- [public model capability discovery](../../../.agents/notes/proposed/feature/2026-09-16-public-model-capability-discovery.zh.md) —— 本包所实现的优先级、快照、缓存与命令行决策。
- [dsh-settings](../../settings/settings/README.zh.md) —— `model-capabilities.publicMetadata` 与同步所写入的 `llm-pi-ai` 文档背后的接缝。
- [dsh-cmdline](../../boot/cmdline/README.zh.md) —— 应用插件如何拥有自己的开关家族与 `--help`。
- [Models 页面](../../client/ui-settings-models/README.zh.md) —— 本层的来源信息展示之处。
- [Command Code model catalog](../../subagent/subagent-commandcode/src/models.ts) —— 始终优先于任何公开声明的本地集成。

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through the capability source a composition registers on `LlmRuntime`.

#### KV Cache effect

本包中没有任何内容进入模型请求：它回答的是 LLM 服务在模型发现期间提出的问题，而部署随后声明的推理强度等级只是普通的请求参数，其前缀效果由提供方自己的缓存规则负责。

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

这些限制界定了本切片止步之处，以及下一片段的起点。

- **推理强度是唯一的能力** —— 视觉、工具、模态、结构化输出与上下文上限都还未读取，尽管 ModelCapabilityProvenance.capability 与解析结果词汇的形态足以承载它们。Models 页面报告的就是这一种能力的来源信息，后续能力会扩展同一份投影。
- **没有周期性刷新** —— 部署在挂载时、设置变更时或按需刷新；定时器是一种配置尚未表达的节奏。
- **`none` 被读作 `off`** —— 公开词元列表以这一条别名规范化，而只提供 `off` 的声明什么也不声明，因此条目只发布 `none` 的模型保持未声明，而不是提供一个选择器无法使用的等级。
- **快照与缓存都只覆盖推理** —— 各自只保留提供方的端点与模型的强度词元，别无其它，因此后续能力必须先往精选中加入自己的字段并升级缓存 schema 才能被解析。
- **每个数据库每轮刷新只抓取一次，且不重试** —— 失败的数据库会在下一轮重试，而 `refresh: auto` 只在下次启动或设置变更时进入下一轮，`--models-refresh` 则按需进入，并非定时进入。
- **缓存以 Harness home 为单位，而非以 profile 为单位** —— 路径由 `resolveDshHome` 解析，因此共享同一 `DSH_HOME` 的安装共享同一缓存，这与其它所有运行时状态的归属方式一致。
- **同步只写入设置接缝所拥有的内容** —— 它编辑 `llm-pi-ai` 文档，因此路由来自组合条目而非设置文档的部署没有可供同步持久化的去处；`check` 仍会报告它。
- **只有随包的 Harnessy profile 挂载该层** —— 官方 profile 不挂载它，因为公开元数据在这里是产品行为，而不是每个部署的默认行为。
- **声明旁边的已解析主张只被报告，不会被套用** —— 该行自己的等级集胜出，而同步会打印目录所陈述的内容，供人判断它所保留的声明。自动调和两者不是本层会做的事。
- No invariant companion is published because 本包拥有的每个观测都是其参数的纯函数，因此独立检查只能重跑同一套匹配并与自身比较。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>Working context for maintainers — click to expand</summary>

本 Dev Note 是非权威的工作上下文：供维护者参考的笔记与未决问题。已发布的行为与已被接受的论证位于上方各节、包代码以及所链接的 Agent Note 中。

- 此处的规范化复现了 `@deepseek-ai/dsh-llm` 已经对来源所作一切声明施加的等级规则，因为接缝中的那份实现是私有的，而调用方需要先拿到规范化后的等级，才能构造它要交回的声明。
- 等级词汇由 `Record` 键类型把关，与 `@deepseek-ai/dsh-llm-pi-ai` 中 `THINKING_LEVELS` 声明的同样七个等级对齐，因此上游的等级变更会在这里编译失败，而不是悄悄收窄公开元数据可提供的范围。
- `tests/fixtures/` 中的解析夹具是所捕获数据库的手工精选子集，外加刻意加入的畸形条目；`tests/fixtures/upstream/` 中的上游输入则是把真实捕获缩减为生成器所读取的字段，而 `.artifacts/`（不纳入提交）保存着派生它们的原始捕获。
- 生成器接受两种捕获形态：原始发布字段名，或缩减后的形态。这正是门禁能针对已提交输入校验产物、而维护者又能用同一条代码路径从新捕获重新生成的原因。
- `refresh: manual` 与 `refresh: never` 提供方式相同，只在是否允许 `--models-refresh` 上有别。未来的周期性刷新会是一个第三种策略，而不是改动这两者之一。
- 快照年龄只在挂载时报告一次，且绝不让其失败：会刷新的部署在首次成功抓取后即替换该产物，而刻意离线的部署会继续供给它。
- 同步所写入的路由来自已解析的 `llm-pi-ai` 段落，而不是原始用户文档：接缝没有提供只读取用户层的方式，而已解析段落是它的超集，因此重述被触及路由的模型列表不会丢掉用户自己的字段。
- `tests/shipped-composition.spec.ts` 通过真实 Loader 启动随包行集合，因此优先级所依赖的注册顺序是被观测到的而非假定的；`packages/bundle/custom-harness/cordis.patch.yml` 与启动夹具之间会比较以防漂移。

</details>
