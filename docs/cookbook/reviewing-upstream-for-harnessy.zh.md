---
description: "仅审查 DeepSeek Harness 上游的新工作，保留 Harnessy 的产品决策，并以简洁建议和已验证的零落后分支结束。"
---

# 操作手册：为 Harnessy 审查上游

[English](reviewing-upstream-for-harnessy.md) | 中文

## 摘要

比较 Harnessy 与 DeepSeek Harness 主仓库时使用此交接文档。它把审查限制为 Harnessy 尚未包含的上游提交，将每项变更路由到当前的 Harnessy 所有者，并把结果整理为 **采用**、**适配** 或 **跳过** 建议。只有当选择会改变可见行为、存储数据、安全性、运行成本或发布范围时，才询问所有者。完成同步时必须包含选定的改进，保留 Harnessy 自定义的 MCP、子代理、账户、工作区、通知和桌面行为，并让仅存在于上游的提交数归零。

不要在此页面存储不断变化的提交哈希，也不要重复已完成的逐提交审计。Git 祖先关系是持久检查点：完成一次同步后，下次审查只从右侧新增提交开始。

## 目录

- [开始之前](#before-start)
- [1. 加载最少的有效上下文](#load-context)
- [2. 仅查找新的上游工作](#find-new-work)
- [3. 保护 Harnessy 的产品决策](#protect-decisions)
- [4. 对每项相关变更分类](#classify)
- [5. 只询问实质性问题](#questions)
- [6. 提出建议](#recommendations)
- [7. 集成并验证](#integrate)
- [可复用的交接报告](#report)
- [开发说明](#dev-note)

-----

<a id="before-start"></a>
## 开始之前

先确认任务范围。**审查**是只读工作，以建议结束。**同步**会获取上游、集成选定工作、运行聚焦检查、按要求提交和推送，并验证 Harnessy 不再落后。仅做建议审查时不要构建安装程序。只有桌面打包发生变化或所有者要求发布产物时才构建。

保留用户未提交的工作。获取或合并前检查工作树，绝不丢弃、覆盖或隐藏无关变更。Harnessy 不需要自动回滚副本；除非所有者明确要求其他备份，否则 Git 提交和远程分支就是恢复点。

使用 `origin` 表示 Harnessy 分支仓库，使用 `upstream` 表示 DeepSeek Harness 主仓库。应验证这些名称，而不是假定其 URL：

```sh
git remote -v
git status --short
```

<a id="load-context"></a>
## 1. 加载最少的有效上下文

先阅读 [AGENTS.md](../../AGENTS.md)。修改 `packages/` 前阅读[架构文档](../architecture.zh.md)，处理生命周期、并发、子进程或清理工作前阅读[防御性模式](../defensive-patterns.zh.md)，编辑实现前阅读适用的软件包 README。不要阅读所有旧 Agent Note。

下列文件构成快速产品地图。每次同步都阅读前三项，然后只打开新上游差异影响到的领域决策。

| 领域 | 当前所有者和聚焦决策 |
| --- | --- |
| 产品身份和贡献者入口 | [根 README](../../README.md)、[自定义组合包 README](../../packages/bundle/custom-harness/README.zh.md) 和 [Harnessy 客户端 README](../../packages/client/ui-brand-custom-harness/README.zh.md) |
| MCP 管理和活动 | [MCP 管理器决策](../../.agents/notes/implemented/feature/2026-09-13-harnessy-mcp-manager.zh.md) |
| 已配置的子代理和路由 | [子代理设置决策](../../.agents/notes/implemented/feature/2026-09-16-subagents-settings-page.zh.md)、[Command Code 通道](../../.agents/notes/implemented/feature/2026-09-15-commandcode-delegation-lanes.zh.md)和[运行时信号与故障转移](../../.agents/notes/implemented/bug-fix/2026-09-19-harnessy-runtime-signals-and-failover.zh.md) |
| 账户、用量和切换 | [多账户管理器决策](../../.agents/notes/implemented/feature/2026-09-12-harnessy-multi-account-manager.zh.md)和[账户用量决策](../../.agents/notes/implemented/feature/2026-09-17-codex-personal-workspace-usage.zh.md) |
| 可选和远程工作区 | [可选工作区决策](../../.agents/notes/implemented/feature/2026-09-12-optional-workspace-sessions.zh.md)和[默认工作区决策](../../.agents/notes/implemented/feature/2026-09-20-default-workspace.zh.md) |
| Windows 后台生命周期和打包 | [桌面 README](../../apps/desktop/README.zh.md)和[分支 CI 决策](../../.agents/notes/implemented/process/2026-09-09-custom-harness-fork-ci.zh.md) |

打开实现文件之前，先扫描上游文件名和差异统计。这会识别表中受影响的行，并避免加载无关的软件包、文档和旧决策。

<a id="find-new-work"></a>
## 2. 仅查找新的上游工作

获取两个远程仓库，然后从当前 Harnessy `HEAD` 计算比较：

```sh
git fetch origin
git fetch upstream
git rev-list --left-right --count HEAD...upstream/master
git log --right-only --cherry-pick --no-merges --oneline HEAD...upstream/master
git diff --stat HEAD...upstream/master
```

计数格式是 `<仅 Harnessy> <仅上游>`。第二个数字是 Harnessy 落后的数量。日志只列出尚未在 Harnessy 中体现的上游提交；不要把左侧的自定义提交当作缺失的上游工作审查。如果第二个计数为零，应停止提交审计。报告 Harnessy 已是最新状态，并且只讨论所有者另行要求的产品改进。

列表很大时，先按受影响的软件包或用户界面分组，再阅读单独差异。优先处理共享 API、持久化、生命周期、安全、提供商行为、桌面打包和触及当前 Harnessy 所有者的代码。仅文档和内部维护变更仍需进行兼容性分类，但不能据此重新打开无关的产品选择。

<a id="protect-decisions"></a>
## 3. 保护 Harnessy 的产品决策

把下表作为默认集成策略。上游可以改进实现，但不得静默替换这些 Harnessy 选择。

| 界面 | 上游集成期间应保留的内容 |
| --- | --- |
| 身份和本地状态 | Harnessy 品牌、安装程序身份和 `%LOCALAPPDATA%\CustomHarness` 保持独立。不要自动导入原版应用状态。在互操作依赖共享软件包和协议标识符时保持其不变。 |
| MCP | 保留一个可视化 MCP 管理器，用于保存本地和 HTTPS 服务器、绝不回显的受保护机密、连接健康、发现的工具、会话标题状态和有界工具调用活动。把有用的上游 MCP 能力并入此所有者，而不是添加第二个管理器或暴露凭据。 |
| 子代理 | 保留一个可定制的子代理页面、命名角色、模型与思考强度选择、访问限制、自动路由、工作区覆盖和实时编辑。倾向使用少量独立且任务规模合适的委派；批处理相关重复工作，不要为每个文件、图像或记录创建一个子代理。父代理继续负责集成和最终验证。 |
| Command Code | 将 Command Code 视为用户所有的委派后端。就绪状态来自其配置的运行时；Harnessy 不得内置其 CLI、凭据或隐藏的后备方案。 |
| 账户和限制 | 保留多个提供商账户、受保护凭据、个人/工作区用量、清晰的限制进度条和明确的自动切换行为。切换失败必须保持可见且可操作。 |
| 通知 | 对根会话完成、失败、批准/访问需求和问题发出通知。避免子代理完成和重复的“已停止运行”垃圾通知。使用未读圆点而不是数字徽章，并为可操作事件保留 Windows 原生通知。 |
| 工作区 | 支持普通本地项目以及无需现有项目文件夹的远程/在线站点工作。远程会话使用所有者选择的父目录（例如桌面）和隔离的每会话子目录，便于删除临时产物。 |
| 桌面生命周期 | 在 Windows 上，关闭主窗口会在确认后隐藏 Harnessy，托盘可重新打开，活动工作继续运行，显式退出则在检查中断风险后真正关闭。 |
| 发布路径 | 保持个人 Windows x64 未签名安装程序工作流与 DeepSeek 已签名的多平台发布基础设施和机密分离。默认不要启用继承的实时服务或私有运行器工作流。 |

优先使用上游扩展点和共享服务，而不是在代理循环中维护长期分支。当上游引入与 Harnessy 页面重叠的能力时，应适配现有页面及其数据所有者；不要创建重复的选项卡、设置命名空间、状态指示器或竞争默认值。

<a id="classify"></a>
## 4. 对每项相关变更分类

为每个相关上游分组指定一个决策：

- 当上游变更可直接带来价值且不与 Harnessy 产品决策冲突时，选择**采用**。
- 当行为有价值但必须进入现有 Harnessy 所有者、文案风格、持久化路径、安全规则、Windows 生命周期或发布工作流时，选择**适配**。
- 当变更依赖 DeepSeek 专属基础设施、重复自定义界面、削弱凭据或状态隔离、以不符合需要的方式改变个人 Windows 产品，或增加维护成本却没有用户收益时，选择**跳过**。

不要仅依据提交标题分类。检查变更的源代码、测试、文档和当前 Harnessy 消费方。每项建议都记录用户收益、受影响所有者、所需适配、冲突风险、聚焦验证，以及是否需要所有者决策。

使用以下默认优先级：正确性和数据兼容性第一；安全和生命周期第二；模型/提供商能力第三；可见易用性第四；重构和内部清理最后。当低优先级重构能在不改变行为的前提下减少自定义差异和未来合并成本时，仍可采用。

<a id="questions"></a>
## 5. 只询问实质性问题

先给出建议和通俗后果，然后仅在答案会改变结果时提出一个简洁问题。合适的问题包括：上游默认值是否应替换 Harnessy 默认值；能力应并入现有页面还是值得创建新界面；是否允许迁移存储数据；是否接受新的外部服务或机密；以及本任务是否还应发布安装程序。

不要要求所有者选择机械性的冲突解决、内部类型名称、测试文件、格式化或其他实现细节。根据仓库规则解决这些事项。当所有者说“使用你的建议”时，应用推荐选项并记录假设。不存在实质性选择时，直接继续并报告结果，不要发送问卷。

<a id="recommendations"></a>
## 6. 提出建议

当仍有选择时，在实现前提供最短的可决策列表。把价值最高的项目放在前面，并把可直接采用的变更与需要 Harnessy 适配的变更分开。说明哪些内容应仅保留在上游及原因；“不适合”必须指出冲突或维护成本。

使用包含以下列的紧凑表格：**决策**、**上游改进**、**Harnessy 收益**、**适配或跳过原因**、**风险/检查**。不要粘贴完整上游日志。仅在源码所有者或提交有助于所有者决策时链接它们。

<a id="integrate"></a>
## 7. 集成并验证

执行同步时，以保留祖先关系的方式集成上游，在上述产品所有者中解决重叠，并更新每个受影响的消费方。保留用户工作，不使用破坏性的重置或检出命令。遵循仓库的推送前流程，并运行覆盖变更界面的最小聚焦行为、类型、文档和打包检查；除非任务明确要求，否则全面平台和实时 API 覆盖由 CI 负责。

集成提交后，验证工作树、祖先关系和分支远程：

```sh
git status --short
git rev-list --left-right --count HEAD...upstream/master
git merge-base --is-ancestor upstream/master HEAD
git rev-parse HEAD
git rev-parse origin/master
```

完成要求：预期工作树干净、第二个计数为零、祖先检查成功，并且在推送属于范围时本地修订与 `origin/master` 一致。第一个计数非零是正常的，因为它代表 Harnessy 专属工作。如果推送或创建安装程序不在任务范围内，应明确说明，而不是把同步描述为已完全发布。

当需要发布产物时，使用分支仓库的 Windows 工作流，并报告工作流结果、产物名称、大小和校验和。把此运行证据放在任务交接或发布记录中，不要放进这个维护页面。

<a id="report"></a>
## 可复用的交接报告

在下次上游审查结束时使用此模板，使后续任务无需重复审计即可继续：

```md
## Upstream status

- Upstream-only commits before work: <count>
- Upstream-only commits after work: <count>
- Scope: review only | synchronized | synchronized and released

## Recommendations

| Decision | Improvement | Benefit to Harnessy | Required adaptation | Risk/check |
| --- | --- | --- | --- | --- |
| Adopt / Adapt / Skip | ... | ... | ... | ... |

## Owner questions and answers

- <Only material choices; write “None” when no choice was required.>

## Integrated work

- <User-visible behavior and its owner, not a raw commit list.>

## Verification

- `<exact command>` — <result>

## Deferred or upstream-only

- <Item and concrete reason.>

## Next review

- Start from `git log --right-only --cherry-pick --no-merges --oneline HEAD...upstream/master`; do not re-audit commits already contained by `HEAD`.
```

<a id="dev-note"></a>
## 开发说明

<details>
<summary>维护者工作上下文 — 点击展开</summary>

此页面是持久交接文档。把不断变化的修订 ID、工作流运行 URL、产物校验和及一次性冲突细节保留在任务或发布记录中。只有 Harnessy 产品所有者、上游审查策略或验证路径发生变化时才更新此页面。

</details>
