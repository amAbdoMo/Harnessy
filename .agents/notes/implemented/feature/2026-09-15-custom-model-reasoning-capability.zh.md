# Agent Note: Custom models declare their own reasoning capability

Status: implemented

[English](2026-09-15-custom-model-reasoning-capability.md) | 中文

## 问题

部署手工声明的模型——例如在 `llm-pi-ai` 下登记的、带 `deepseek/deepseek-v4.1-flash` 的 Command Code 这类 OpenAI 兼容网关——请求一切正常，但即便端点接受 `reasoning_effort`，组合器的推理等级控件也从不出现。

能力抽象本身早已存在，并且已经抵达每一个消费方。`LlmAdapter.resolveModel()` 返回 `LlmResolvedModelInfo.reasoning`（有序等级加可选默认值），`LlmRuntime` 校验它并以 `UNSUPPORTED_REASONING_EFFORT` 拒绝不受支持的请求等级，`buildModelCatalog` 把它投射到浏览器线上，组合器的选择器只渲染这些等级，`preflightChildLlmRoute` 也通过同一次调用解析每个子路由。内置适配器从各自目录填充它。`llm-pi-ai` 本就能按模型通过 `PiAiModelProfile.reasoningEfforts` 声明它：键是提供的等级，值是该等级的过线拼写。

两处缺口让它未能成为产品能力。模型页没有任何地方写入该字段，因此自定义路由只能靠手工编辑 `settings.yaml` 才能获得等级。而 profile 唯一的默认等级是路由级的（`PiAiProviderProfile.reasoning`），所以同一条路由下的两个模型无法派发不同的默认值——尽管它们提供的等级集合本就不同。

## 决策

扩展既有抽象，不新增第二套推理词汇。`LlmResolvedModelInfo.reasoning` 仍是唯一事实来源，由组合器选择器、会话模型目录、ACP 与子代理预检共同读取；提供方适配器仍是把归一化等级变成请求字段的唯一位置。

`PiAiModelProfile.defaultReasoningEffort` 指定某模型的请求在未指明等级时派发的等级。它优先于路由级的 `reasoning`，后者继续作为所有未自行声明的模型的回退。`RouteCatalog.configuredReasoningDefaults` 按模型 id 承载它，这正是 `configuredMaxTokens` 已经采用的分工：提供的等级是模型的能力，落在物化后的 pi-ai `Model` 上成为 `thinkingLevelMap`；请求默认值则是部署的选择，绝不进入该模型。解析会拒绝不是该条目自身 `reasoningEfforts` 键的默认值，也会拒绝与省略或 `false` 的等级声明并存的默认值，因为这两种状态都没有可提供过线拼写的等级。

模型页的模型行拥有能力编辑器，位置就在原本承载容量的展开区内。它声明三种状态之一——沿用适配器自身的答案（省略该字段）、显式声明支持并列出提供的等级，或显式声明不支持（`false`）——随后是提供的等级与默认等级。等级词汇从适配器自身的 `Config` schema 中读出（`ui-settings-models` 中的 `reasoningEffortChoices`，与 `protocolChoices` 读取协议所用机制相同），因此页面提供的正是适配器接受的等级，而不是由本客户端维护的清单。每一行独立声明，这正是同一条路由下的两个模型可以互不影响地各不相同的原因。

编辑器把归一化等级名写成过线拼写——`low: 'low'`，以及 `off: null`，后者对应拼写即参数缺席的那个等级。拼写与等级名不同的网关仍可在 `settings.yaml` 中自行设置 `reasoningEfforts` 的值；行内控件负责声明提供的等级，profile 的值仍是翻译层。

既有自定义模型无需改动即可继续工作：省略的 `reasoningEfforts` 依旧表示「此处没有声明」，该行显示适配器的默认答案，而编辑该行的任何其他字段都不会物化出无人提出的声明。这也是声明采用三态控件而非复选框的原因：对于继承目录推理能力的已内置路由，「未声明」与「声明为不推理」是两种不同的请求，两态控件必然要把其中之一说成不实之事。

## 模型等级从何而来

解析顺序是固定的，每一步只陈述它真正知道的内容。提供方自身的元数据排在最前：`GET /models` 条目若带有 `reasoningEfforts`（驼峰或下划线拼写皆可，可选 `defaultReasoningEffort` 且必须命名其中之一），`dsh-llm-pi-ai` 的发现流程会读取这些等级并交给界面，于是采纳该模型时以提供方的答案起步，而不是要求用户重述。其次是已安装目录：对于 pi-ai 自带的路由，发现流程报告该确切模型由 `getSupportedThinkingLevels` 记录的等级集合，而 profile 条目未作声明时，解析本就会继承它。第三是逐模型显式声明；其余情形即为未声明，此时完全不显示推理等级控件。

不得由任何其他信息补全。未声明等级的条目不产生等级；空列表、非数组、仅含 `off`、或含不可用成员的等级列表，只产生可用部分或什么都不产生；不在自身列表内的默认值会被丢弃而不是修补。`LlmRuntime.discoverModels` 是所有回答唯一经过的归一化步骤，因此无论由哪个适配器作答，这些规则都成立。来源信息不存放在模型行上：等级集合来自何处是一次读取的属性，而不是模型的属性，因此选择器只标注它正在展示的那份列表的来源，而不持久化一个会随提供方变化而腐烂的声明。

因此，模型编辑器的获取选择器会展示每个候选的确切等级（按组合器将使用的名称），并在上方标明该列表来自适配器已安装目录还是提供方自己的模型列表；区分二者的是路由的 `declared` 标志，因为适配器自带的路由根本不会触达网络。采纳候选时，这些等级通过与行内复选框共用的同一次转换写入该行，因此导入的集合与手选的集合存储结果完全一致——包括 `off`，其过线形式即参数的缺席。未作声明的行会在控件处说明这一点，并说明两种取得等级的途径中哪一种适用于它。唯一会被采纳补全的情形，就是该行除此之外什么都没声明：导入的等级集合填补的是一个空缺，而行已声明的每个值——包括显式拒绝与调好的容量——仍然优先。

## 提供方在模型列表之外发布的能力

有些提供方通过模型列表端点之外的渠道回答能力问题。Command Code 就是现成的例子：它的 `--list-models` 列表只带 id 与描述，其 `--effort low|medium|high` 标志只是一套固定词汇，并未说明某个模型实际接受哪些等级——`deepseek/deepseek-v4-pro` 接受 `high` 与 `max`，`z-ai/glm-5.3-flash` 接受 `low`、`high`、`max`，而 `Qwen/Qwen3.8-Flash` 接受 `low`、`medium`、`xhigh`。把该标志的三个取值套用到每个模型，对这三者都是错的。

`LlmRuntime.registerModelCapabilitySource` 正是为这种情形提供的唯一扩展点。已安装的集成注册一个按精确模型 id 作答的查询——并且会收到发现请求，因为裸模型 id 在不同提供方之间并不唯一——而 seam 只在适配器什么都没声明的模型上询问它，因此提供方自己的列表始终优先。回答会经过与适配器声明相同的归一化：可用成员与不可用成员并存时保留可用者，仅含 `off` 的集合不构成能力，未命名任何已声明等级的默认值不命名任何东西。这一切发生在发现阶段而非解析阶段：按 id 作答的逐模型答案否则会被归属到任何服务该 id 的路由，而像 `claude-sonnet-5` 这样的名字并不专属于 Command Code。

`@deepseek-ai/dsh-subagent-commandcode` 是第一个来源。它读取 CLI 自带、并用于校验其自身 `model:effort` 简写的目录——即已安装入口点旁边的 `bundled/command-code-knowledge/reference/models.md`，其 `Efforts` 列给出每个模型的等级，并用破折号表示自行决定深度的模型——并在首次查询时惰性解析。它只为命名了 Command Code 或指向 `commandcode.ai` 端点的路由作答，并原样保留 Command Code 的等级名而不作翻译，因为翻译层是 seam 的归一化与适配器自身的键词汇。

## 验证

`packages/llm/llm-pi-ai/tests/catalog.spec.ts` 覆盖无声明的模型、显式 `false`、同一条路由下逐模型的等级集合与默认值、以 `off` 为默认值，以及每一条拒绝分支。`packages/llm/llm-pi-ai/tests/config.spec.ts` 覆盖 schema 边界与解析后的逐模型映射。`packages/llm/llm-pi-ai/tests/adapter.spec.ts` 证明模型自身的默认值优先于路由的，同一路由上的另一个模型仍沿用路由的，并证明请求未指明等级时声明的拼写会作为 `reasoning_effort` 抵达线上。`packages/llm/llm-pi-ai/tests/discovery.spec.ts` 覆盖以两种拼写声明等级的列表、重复项与不可用成员、仅含 `off` 的集合、不在声明集合内的默认值、沉默条目，以及已安装目录对标记为推理与未标记为推理的模型各自的回答。`packages/llm/llm/tests/topology.spec.ts` 覆盖该回答在 seam 处的归一化、能力来源为适配器未描述的模型补全、适配器自身声明优先于来源、来源回答经过同一归一化、向来源提出的问题携带请求，以及注册冲突与撤回。`packages/subagent/subagent-commandcode/tests/models.spec.ts` 覆盖目录读取器：包含并非 `low`/`medium`/`high` 的确切逐模型集合、破折号与空单元格表示不作声明、不可用成员与未知等级名、两个平台上的入口点解析、不可读目录、路由归属，以及按插件生命周期的记忆化。`packages/client/ui-settings-models/tests/provider-form.client.spec.tsx` 覆盖声明、等级勾选、默认值选项、取消勾选默认等级时一并撤销默认值、`false` 与适配器默认两条路径、逐行独立、编辑后仍不替未声明的模型声明、适配器没有词汇表的情形、在沉默候选旁采纳已声明的等级、两种路由各自的来源说明，以及两种未声明提示。`packages/client/ui-model-selection/tests/model-select.client.spec.tsx` 覆盖暂存另一个模型会替换可用等级，以及新选模型不支持的等级会重置为该模型自身的默认值。`packages/subagent/tool-subagent/tests/model-selection.spec.ts` 覆盖父级请求的子代理等级不被所选模型提供时，在创建任何子代理之前即被拒绝。

## 考虑过的替代方案

**提供方级的推理控件。** 放弃：同一提供方下的模型等级各不相同，提供方级开关只可能被设成某些模型会拒绝的集合，从而把整条路由踢出所有选择器。

**按需求原文引入 `ModelCapabilities` 类型。** 放弃：等价抽象已作为 `LlmResolvedModelInfo.reasoning` 存在，已由 `LlmRuntime` 校验，并已被每个消费方读取。再建一个类型只会制造全局设计所禁止的重复能力元数据。

**布尔型「推理」复选框。** 放弃：该声明有三种状态，复选框只能把确实会推理的目录模型渲染成「关闭」——一个与请求实际行为相反的控件。

**客户端维护等级清单。** 放弃：它会与适配器的 `THINKING_LEVELS` 静默漂移。从所属 namespace 的 schema 读取该 union 则不会漂移，且本构建没有对应名称的等级会回退到其 id。

**为所有自定义模型自动宣称支持推理。** 放弃：端点的 `/models` 列表只报告 id 与容量，从不报告推理协议，因此这一宣称只是猜测，会破坏既有模型。手工声明仍然可用，profile 也仍可手写。

**路由级推理默认值。** 放弃：同一路由下的模型等级各不相同，而 Command Code 自己的目录显示差异可以有多大——`deepseek/deepseek-v4-pro` 提供 `high` 与 `max`，而 `Qwen/Qwen3.8-Flash` 提供 `low`、`medium` 与 `xhigh`。按路由声明一次，等于宣称一个其多数模型都会拒绝的集合。

**在解析阶段而非发现阶段回答能力来源。** 放弃：来源以模型 id 为键，而像 `claude-sonnet-5` 这样的 id 并不专属于声明该注册表的提供方，因此解析阶段的补全会把一个提供方的等级安到另一个提供方的模型上，且用户无从复核。在发现阶段，等级会在写入任何内容之前展示出来。

## 后果

经由产品录入的手工声明模型现在可以声明推理、其等级与默认等级，而每个消费方无需改动即已读取到它们。profile 格式新增了一个字段，因此生成的配置目录、提供方指南与两个包的 README 都随之更新。

代价是模型行的展开区现在在容量旁同时承载能力，其标签因此读作「能力」；以及拼写与等级名不同的网关仍需在 `settings.yaml` 中配置，因为该行有意只提供归一化等级，而不是逐等级的值编辑器。

`packages/test-support/llm-replay` 为回放适配器声明了自己的一套逐模型 `reasoningEfforts`/`defaultReasoningEffort` 词汇。本次为此发现流程线上类型采用的正是它的 `string[]` 形状，但该适配器自身的配置并未与本次统一。

Command Code 委派路径在此不做任何声明：其集成只读取 CLI 的 `--list-models` 文本列表，解析为 `{ id, description }`，而它的推理强度是逐通道的运行标志。上文那些逐模型集合正来自它自带的目录，CLI 升级若改版该目录，来源的回答随之改变，而此处无需任何改动。
