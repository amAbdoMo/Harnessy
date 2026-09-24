# Agent Note: Retire the Delegation Settings page into the Subagents page

Status: implemented

[English](2026-09-16-retire-delegation-settings-page.md) | 中文

## 问题

`custom-harness` 配置档为同一个功能挂载了两个设置页面。`ui-settings-commandcode` 编辑 Command Code 通道文档，而子代理页面编辑这些通道迁移到的统一角色目录，列出每个角色路由到的后端，并向 Command Code 后端询问其自身的安装与登录状态。两个导航条目为同一件事写入两个命名空间。

委派页面提供的一切除一个控件外都已迁入该页面。通道的推理强度可以从 Command Code 的词表中选择，而子代理页面无法提供它：`ctx.remote.commandcode.catalog()` 对每个模型只返回 id 与描述，没有任何推理元数据，因此本页面的规则——只提供路由公布的级别——正确地给出了说明文字而非级别。已存储的 `reasoningEffort` 仍会送达 `--effort`；只是无法*选择*。

## 决策

拥有自身模型空间的后端现在会声明其模型接受的推理级别，而委派页面已删除。

词表是后端的属性，因此它位于 `backends.ts` 中后端名称旁，而不是放在选择器里：每个拥有自身模型空间的后端一条表项，每个级别带一个字典键而非字面标签。`commandcode` 声明 `default`、`low`、`medium` 与 `high`，这正是 CLI 自身的 `--effort` 词表。`default` 是表示完全不请求任何级别的 id——选择器现有的模型默认选项正是这个含义，且它不存储任何 `reasoningEffort`——因此它永远不会作为一个单独的级别出现，也不会有任何字面 id 进入选择器。

`commandCodeModelGroups(catalog, backend, vocabulary)` 会把这些级别附加到每个投影出的模型上，这正是后端自有空间的级别应有的位置：其清单不声明任何级别，而每个级别同等地适用于其所有模型。除此之外选择器的规则不变，因此来自 Host 目录的模型仍然只提供 `model.reasoning.efforts` 所列的级别、未公布任何级别时则不提供；更换模型时的收窄现在也会像同一模型内那样，在后端自有空间内保留推理强度。

退役只涉及挂载点与引用。`packages/bundle/custom-harness/cordis.patch.yml` 保留 `commandcode-delegation` 宿主行并移除客户端行；bundle 清单、`tsconfig.base.json` 别名、`tsconfig.client.json` 引用、生成的客户端槽位目录，以及两处指名该页面的 README 行随之更新。`packages/subagent/subagent-commandcode/**` 保留其工具、`commandcode` 后端、健康探测、限流器与运行机制；`commandcode-delegation` 设置命名空间、其存储的 `projects` 覆盖层，以及 `ctx.remote.commandcode.health` 与 `.catalog` 都原样保留，因为子代理页面现在自行读取该命名空间的健康状态与目录。

## 备选方案

**保留委派页面并在那里添加推理强度控件。** 少删一个东西，而且该页面本就拥有通道文档，而通道带有推理强度。它落选是因为这个缺口正是让该页面存续的唯一原因：页面上的其他每个控件——通道成员、运行上限、工作区覆盖、CLI 状态——都已在子代理页面上，或通过同一个 Remote 命名空间读取，因此保留它只会为一个控件再保留一个导航条目和一个包。

**让推理强度选择器维持全局规则，使后端自有的级别始终不可选。** 无需新词表，且迁移已经存储了通道携带的推理强度。它落选是因为这会退役用户当下拥有的能力：已存储的推理强度会送达 `--effort`，却无法选择另一个，而且任何界面都不应在丢掉其原有能力的情况下被退役。

**在选择器中硬编码 Command Code 的级别。** 这是达成同一控件的最短路径。它落选是因为词表属于后端而非本页面：拥有自己级别的第二个后端将不得不修改该组件，而这正是该表要防止的散落。

**通过后端自身的目录应答发布级别。** `cmd.health`/`cmd.catalog` 已经承载后端自有的事实，把 `CommandCodeCatalog` 扩展为每个模型带一组级别本可以让页面不涉及词表。它在归属上落选：级别并非逐模型——CLI 对其整个模型空间只接受一套词表——因此逐模型发布会声明一种 CLI 并不具备的关系，而且需要改动 `subagent-commandcode`，而本次变更刻意不做这件事。

## 影响

Harnessy 只保留一个委派界面。后端区块、角色卡片、工作区覆盖与自动路由授权都留在原处，已退役页面所呈现的 Command Code 状态、目录与角色都可以通过它们抵达。

拥有自身模型空间的后端现在必须在 `backends.ts` 中被指名，才会提供其级别；本页面不认识的后端不贡献任何词表，其路由保持其清单所声明的级别——对这类后端而言就是没有。这是一份静态清单，也是不凭页面自身权威捏造级别集合的代价。

`commandcode-delegation` 分区作为数据比它的页面存续更久，由角色目录的一次性迁移读取，并原样保留以便用户仍可查看或回退。已不再有任何东西写入它。

`docs/subsystems/subagent.md` 中生成的 `cordis-surface` 区域仍把 Command Code 的健康事实描述为「委派页面显示的」内容，因为该文字是从 `packages/subagent/subagent-commandcode/src/index.ts` 的 JSDoc 投影而来，而本次变更未改动它；这属于措辞过时，而非仍存在的界面。

## 相关

- [Harnessy 通过一个设置页面编辑统一子代理角色目录](2026-09-16-subagents-settings-page.zh.md) —— 本次变更后仅存的委派界面。
- [Harnessy 通过用户自有通道委派给 Command Code](2026-09-15-commandcode-delegation-lanes.zh.md) —— 通道文档及其已退役的页面。
- [Harnessy 挂载统一角色目录并把已存通道配置带入其中](2026-09-16-subagent-roster-legacy-migration.zh.md) —— 读取本次变更不再写入的通道文档的那次迁移。
