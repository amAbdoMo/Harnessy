# Agent Note：Codex Personal 与 Workspace 用量是同一用户的独立 membership

状态：已实现

[English](2026-09-17-codex-personal-workspace-usage.md) | 中文

## 问题

账户管理器曾把 ChatGPT account id 当作唯一用户 id。该值标识 workspace，并由其中的成员共享，因此同一 workspace 中的两个用户登录后，后者会覆盖前者保存的账户。相反的情形也缺少合适展示：同一用户登录 Personal 与 Workspace 后会显示为互不相关的两行，无法在原处比较两个额度上下文。

完整账户管理器还会把所有用量条绘制为品牌色，而紧凑的侧边栏用量条已经区分正常、警告与危险消耗。

## 决策

每个 Codex OAuth membership 现在都有一个由 ChatGPT user id 与 workspace account id 共同派生的不透明 id。另一个仅由 user id 派生的不透明 owner id 表示用户。旧 token 缺少首选 claim 时，email、JWT subject 与 refresh-token fallback 仍保留同样的两层身份。可写 vault 在读取时迁移旧的 workspace-only id，同时保留当前 membership、自定义名称与用量快照。

Host 返回两个 id，以及 `personal` 或 `workspace` 用量范围。provider badge 按 owner id 计数，而浏览器把相同 owner id 的 membership 合并到一张卡片。只有两个范围都存在时，卡片才显示 Personal/Workspace 分段控件。切换控件会选择额度快照、重命名或移除目标，以及 Switch 激活的 membership；仅有 Personal 或 Workspace 的账户不会显示多余控件。

完整和紧凑的用量条共用一个分类器：低于 80% 为正常，从 80% 起为警告，从 95% 起为危险。界面继续使用三种颜色对应的语义主题 token。

完整账户卡片把较短的 `5h` 重置时间显示为以分钟为单位的倒计时，并在卡片打开期间以及窗口重新获得焦点或可见时更新。`7d` 重置时间仍显示为本地绝对日期和时间，但省略多余的年份。紧凑侧边栏会在启动时、可见期间每分钟以及窗口重新获得焦点或可见时刷新账户用量；它的用量条会直接跳到最新值，因此从其他应用返回时不会重播过时的进度动画。

Codex 自动切换是 provider 的可选偏好，仅在所有已保存 membership 都取得最新用量结果后评估。标准 `5h` 或 `7d` 窗口中任意一个达到 100%，当前 membership 就视为已耗尽；替代项必须至少提供一个标准窗口，并且所有已提供的标准窗口都低于 100%。选择顺序依次为具有相同 ChatGPT workspace id 的另一个席位、同一所有者配对的 Personal 或 Workspace membership，以及当前 membership 为 Personal 时的另一个 Personal membership。它绝不会在互不相关的 Workspace membership 之间切换；没有符合条件且有额度的替代项时，当前凭据保持不变。

启用自动切换后，账户控制器会在 `agent/request` waterfall 中重复执行该刷新与选择；此时请求路由已经确定，但 `prepareCall()` 尚未解析 canonical credential。一次已提交的提升会发出不含秘密的 `accounts/auto-switched` 事件。浏览器把该事件显示为短暂 toast，并在本地通知历史中最多保存 50 条切换记录；历史从 Workspaces 工具栏打开，打开时标记为已读，使用“清除历史记录”即可删除。

## 考虑过的替代方案

**按 workspace id 为保存的账户建立 key。** 这能保留现有 vault 布局，但无法表示同一 Business 或 Enterprise workspace 中的两个用户。

**把 Personal 与 Workspace 凭据合并为一条存储记录。** 这样卡片模型更直接，但会同时要求新的凭据 schema，并改变激活、刷新、重命名与移除语义。继续把每个 OAuth membership 存成一个账户，可以保留 canonical credential 路径，只让客户端合并展示。

**始终显示范围切换控件。** 固定布局看起来有吸引力，但禁用或仅有一项的切换控件会表达一个并不存在的选择。因此只有两种范围都存在时才显示它。

**轮换所有已保存的 Codex membership。** provider 范围的轮询最有可能找到剩余额度，但它可能把 Business 工作发送到无关组织的 workspace。自动选择改由 workspace 身份与所有者配对共同约束。

## 后果

即使两个 workspace 成员的 token 带有相同 ChatGPT account id，也可以分别保存和切换。同一用户可以保存 Personal 与 Workspace membership，在一张卡片中比较它们各自的 `5h` 与 `7d` 窗口，并选择激活哪一个 membership。

重置信息保持易读且不会因秒级变化产生干扰：短窗口报告剩余的完整分钟数，周窗口保留紧凑的日历时间。后台窗口在用户返回时立即追上最新状态，紧凑侧边栏始终直接显示最新收到的快照，不使用宽度过渡动画。

公共账户视图新增 `ownerId` 与可选 `usageScope`。每个公共账户都有 owner id；非 Codex provider 使用存储账户 id，因为其条目不提供独立用量 membership。现有可写 Codex vault 会在账户管理器下次读取时迁移，而且不会向浏览器暴露源身份 claim。

自动切换会在下一个 Codex 请求绑定凭据前发生，因此已知耗尽的当前 membership 不会进入该请求。它不会重定向已经进行中的请求。失败或缺失的用量快照不能证明仍有额度，因此既不会触发自动切换，也不会成为自动切换目标；用量服务失败会被记录，但不会阻止其他方面有效的模型请求。

转发的切换事件仅包含显示名称、用量范围、已耗尽的标准窗口、id 与时间戳，绝不包含电子邮件地址、account id 或 OAuth 数据。通知历史属于浏览器本地状态，而不是 Session 数据；只有明确的清除操作或移除浏览器存储才会删除它。

## 相关内容

- [Harnessy 浏览器身份与账户管理器](../../../../packages/client/ui-brand-custom-harness/README.zh.md)
- [客户端 UI 文案由 locale 拥有](../architecture/2026-08-23-locale-owned-client-ui-copy.zh.md)
