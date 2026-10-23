---
description: "由桌面端管理的原生手机配对及现有同机 Session 加密访问，包含本地批准和授权撤销。"
kind: "package-reference"
---

# @deepseek-ai/dsh-companion-host

[English](README.md) | 中文

## 概述

通过本地批准的手机监控普通电脑聊天、打开符合条件的已有聊天并排队提交后续任务。电脑可分别授权聊天管理、打开已有聊天、仅限当前会话的模型选择及受限工具详情。配对需要一次性邀请与指纹批准，但不授予上述任何权限。手机不能删除聊天、批准工具、浏览文件、运行任意命令或调用操作员 API。准备源码不会更新已安装的应用。

## 目录

- [使用此包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用此包

集成负责人在安装私有桌面所有权能力后，在 Desktop Host 配置中挂载此默认服务；源码 API 和协议细节见[Integration](INTEGRATION.md)（[中文](INTEGRATION.zh.md)）。

### 配置

省略 `httpsOrigin` 会使可选功能不可用，且不会生成身份或打开套接字。配置来源时必须使用真实部署的规范 HTTPS 来源，并显式填写 `budgets` 的每个字段。空白来源、不完整预算、非正限制、不安全的计时器间隔、不一致的字节限制及已存储来源的变更均在加载时失败。`maxFrameBytes` 至少为 96 KiB，在 ws 组装前覆盖规范化中继封装；活动输入饱和只拒绝准确的手机实例，不关闭共享 PC 套接字。重连退避批次持续到 Host 退役，但不重放修改请求。不会生成示例主机名，也不会将其视为可用中继。

| 字段 | 默认值 | 含义 |
|---|---|---|
| `httpsOrigin` | 省略：不可用 | 真实公开 HTTPS 中继来源，固定在凭证记录中。 |
| `budgets` | 配置来源时必填 | [配置模式](src/config.ts)中显式的准入、保留、连接和应用限制，包括 `channel` 的加密队列与写入时间限制。 |

### 只读 Workspace 导航

可选的 `listSessions` 导航视图仅对返回的可见普通 Session 镜像 PC Workspace 成员关系和置顶状态。按 Workspace 注册表顺序找到的首个显式成员关系提供 Workspace ID、净化后的标题和顺序；没有成员关系时返回 `null`。响应不包含文件夹路径／cwd 或空 Workspace 清单，也绝不根据 Session 标题、ID 或 cwd 推断成员关系。`pinOrder` 是全局 PC 置顶排名，不是各 Workspace 内的排名。此视图仍是只读投影；单独授权的管理命令可以修改 PC 置顶。与普通列表不同，获准的 Workspace 目录包含已注册的空 Workspace，不含路径。参见[管理权限与兼容性](../../../docs/upgrade-guide/v0.1.15/companion-chat-management/guide.zh.md)。

`updatedAt` 与 Desktop 最近时间一致：取 Session 创建时间与缓存的最近一次已持久化人工提示时间的较大值，不使用助手完成时间或任意活动时间。[Session 视图](src/session-view.ts)读取缓存投影，不加载所有 Session 日志。旧请求省略导航元数据。使用请求导航视图的手机前，必须先更新 PC；参见[兼容性与更新顺序](../../../docs/upgrade-guide/v0.1.15/companion-navigation/guide.zh.md)。

### 打开已有聊天

手机可在电脑运行时显式打开符合条件的已有普通聊天，无需改变 Desktop 导航。`getSessionActivation` 报告该手机单独的电脑权限；只有 `openSession` 会显式激活，而会话列表、历史和进度读取绝不激活冷态 Agent。`sessionActivationV1` 授权默认拒绝，且独立于配对、聊天管理、模型选择和工具详情。Desktop Main 的原生**已配对手机**对话框会在核对指纹后显示**启用打开聊天**。冷态激活使用电脑的常规 Agent 初始化和目标刷新；准入后，即使手机取消等待，API 仍负责完成，因此回复可能为 `unknown`。打开操作不会创建 Session 或任务，也不会发送文本。参见[会话激活与更新顺序](../../../docs/upgrade-guide/v0.1.17/companion-session-activation/guide.zh.md)。

### 模型与工具详情

电脑原生界面针对准确手机指纹，分别决定是否启用模型选择与工具详情。模型选择使用电脑已配置的路由，仅适用于已运行且空闲、无排队任务的普通聊天；只影响该聊天的下一次请求，不更改全局默认值。工具详情可从历史及实时活动显示工作区相对文件标签、读取范围、固定写入／编辑结果和搜索计数。文件名可能敏感；撤回权限会停止后续传送，但无法抹去已接收的文本。参见[更新顺序与记录兼容性](../../../docs/upgrade-guide/v0.1.17/companion-model-and-tool-consent/guide.zh.md)。

详情仅使用允许列表内的成功结果元数据和准确调用关联，不使用参数、内容、差异、终端命令或错误文本。外部路径及格式错误的元数据不会传送；无法关联调用时显示固定状态。工具名称和元数据以可信电脑工具组合为前提，并非经过认证的生产者身份。嵌套 PTC 详情不可用。

### 配对及后续任务权限

Desktop Main 通过私有 IPC 复制一次性原生 URL，并拥有指纹批准与移除对话框；渲染进程仅接收可用性、连接状态和配对数量。原生应用可粘贴 URL；此包不宣称生成二维码。操作员必须准确批准显示的候选和指纹。**后续文本可能使现有 PC Agent 按该 Session 的现有权限运行正常工具和任务。** 伴随功能不会增加工具批准权限。

手机不得自动重试提交。`submitted` 结果仅表示内存收件箱准入，不表示持久送达、执行、任务完成或回执。收到确认前断线，包括准入后的检查点失败，均表示送达情况未知。离线修改不会被排队或重发。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节 — 点击展开</summary>

启动时安装的桌面能力与无到期时间的内核锁将连接器限制为每个规范本地 home 的单一所有者。暂停或无响应的进程仍保有独占权；其他进程不能根据过期心跳夺取所有权。现有凭证服务保存私有 PC 身份和当前授权。出站 WSS 连接器签署中继为套接字新生成的挑战；仅凭中继转发的身份不能授权手机。共享协议验证完整手机签名 hello、配对 HMAC、PC welcome 和双向加密密钥确认。当前授权代际与可同步撤销的通道信号授权每次应用分派和最终后续文本准入。

冷文本历史使用调用者拥有的查询租约，不激活 Agent。结果包含有界摘要、批准的纯文本及单独授权的工具元数据，不包含原始工具负载、推理或任意投影。完整编码消息计入 UTF-8 预算。读取游标经过认证并绑定上下文。实时订阅仅保留有界的待完成调用标识；不可变历史观测负责解析更早的调用，不同步读取 Session 日志。

[构建配置](tsdown.config.ts)将提供方与 `/desktop-control` 编解码器输出为独立 Node 入口。Desktop 的[打包配置](../../../apps/desktop/tsdown.config.ts)内联编解码器及其协议依赖，不保留未随包提供的运行时导入；Main 不加载 Host 提供方。

[服务](src/index.ts)、[连接器](src/connector.ts)、[记录](src/records.ts)、[桌面所有权](src/desktop-owner.ts)和[应用分派](src/application-dispatch.ts)拥有精确实现。

</details>

-----

<a id="further-exploration"></a>
## 进一步阅读

- [架构](../../../docs/architecture.zh.md)：现有 Session 和插件所有权。
- [共享协议](../../util/companion-protocol/README.zh.md)：密码学转录与应用 JSON。
- [中继](../companion-relay/README.zh.md)：实时路由与部署准入。
- [Integration](INTEGRATION.md)（[中文](INTEGRATION.zh.md)）：原生链接、存储及 Desktop 拥有的接线。

-----

<a id="model-experience"></a>
## 模型体验

通过正常 Session 用户文本准入和 Agent 请求组装间接影响模型；此包不新增模型工具或提示词段落。

#### KV 缓存影响

获准后续文本与正常排队的 PC 用户文本对上下文及 KV 缓存复用的影响相同；读取和配对不新增模型请求。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

以下集成与验证限制保持明确。

- 实体 Android 互操作性与原生 Windows 安全验收需要单独验证；无需密钥的测试和静态编译不能证明这些要求已满足。
- 启用需要真实部署的中继来源、显式预算和离线 Desktop 构建。编辑源码不会改变运行中的应用或已安装凭证数据。
- 签名 hello 没有显示名称元数据；候选和设备名称保持为空。共享应用状态没有本地 PC 操作状态。部分助手增量需要单独的有界协议表示，当前不导出。
- Windows 凭证 ACL 验证仍延期。复制 PC 凭证 home 会克隆其私有身份；本地 home 锁不能阻止另一台 PC 或另一份 home 的所有权。
- 凭证提供方在来源故障后保留最后有效的读取缓存。伴随功能在初次准入前检查永久来源故障信号，并在 `credentials/source-failed` 时撤回权限；修复存储后须重启提供方和 Host，手机权限才会恢复。
- 凭证提供方使用无 fsync 的原子替换。撤销完成表示提供方提交与通道静止，不表示超出该提供方能力的断电持久性。
- 部署验收仍要求原生互操作、对抗性中继或通道行为、应用转录快照及组装后的 Desktop/Android 端到端证据。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

无。

</details>
