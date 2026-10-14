---
description: "由桌面端管理的原生手机配对及现有同机 Session 加密访问，包含本地批准和授权撤销。"
kind: "package-reference"
---

# @deepseek-ai/dsh-companion-host

[English](README.md) | 中文

## 概述

在本地批准的原生手机上监控现有普通 PC Session，并向这些 Session 排队提交后续文本。配对需要一次性邀请，以及在 PC 上明确批准手机指纹。手机不能创建 Session、批准工具、浏览文件、运行命令或调用操作员 API。此源码包需要桌面端及部署集成；本次未在已发布配置中启用。

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

### 配对及后续任务权限

Desktop Main 通过私有 IPC 复制一次性原生 URL，并拥有指纹批准与移除对话框；渲染进程仅接收可用性、连接状态和配对数量。原生应用可粘贴 URL；此包不宣称生成二维码。操作员必须准确批准显示的候选和指纹。**后续文本可能使现有 PC Agent 按该 Session 的现有权限运行正常工具和任务。** 伴随功能不会增加工具批准权限。

手机不得自动重试提交。`submitted` 结果仅表示内存收件箱准入，不表示持久送达、执行、任务完成或回执。收到确认前断线，包括准入后的检查点失败，均表示送达情况未知。离线修改不会被排队或重发。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节 — 点击展开</summary>

启动时安装的桌面能力与无到期时间的内核锁将连接器限制为每个规范本地 home 的单一所有者。暂停或无响应的进程仍保有独占权；其他进程不能根据过期心跳夺取所有权。现有凭证服务保存私有 PC 身份和当前授权。出站 WSS 连接器签署中继为套接字新生成的挑战；仅凭中继转发的身份不能授权手机。共享协议验证完整手机签名 hello、配对 HMAC、PC welcome 和双向加密密钥确认。当前授权代际与可同步撤销的通道信号授权每次应用分派和最终后续文本准入。

冷文本历史使用调用者拥有的查询租约，不激活 Agent。手机结果包含有界摘要、批准的纯文本和经过净化的实时活动，不包含原始工具参数或结果、推理、文件系统元数据或任意投影。完整编码消息计入 UTF-8 预算。分派器签发绑定上下文的认证读取游标，不保留无界游标映射。

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
