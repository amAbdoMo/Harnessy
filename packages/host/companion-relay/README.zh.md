---
description: "在托管 HTTPS 反向代理后配置有界的实时 PC/手机密文会合。"
kind: "package-reference"
---

# @deepseek-ai/dsh-companion-relay

[English](README.md) | 中文

## 概要

PC 与手机可通过同一个部署源交换实时加密的 companion 消息。每条连接使用新鲜、限时且绑定 socket 的挑战证明其 P-256 身份密钥的持有权。手机只能连接所选的在线 PC；该 PC 负责配对、授权记录、撤销及应用授权。运维人员必须提供托管 TLS 反向代理，以及全部准入、字节、队列和时间预算。

## 目录

- [使用此包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发笔记](#dev-note)

-----

<a id="use-this-package"></a>
## 使用此包

将这个具名插件与 `@deepseek-ai/dsh-host-webserver` 一起挂载，或选择[独立 bundle](../../bundle/companion-relay/README.zh.md)。精确的 upgrade 路由是 `/companion/pc` 和 `/companion/phone`；普通 HTTP 响应仍由 webserver 负责。

### 部署配置

[Config](src/config.ts) 中的全部字段都必填。[bundle patch](../../bundle/companion-relay/cordis.patch.yml) 将每个字段映射到显式环境变量；profile patch 也可替换 relay 行的完整 config。插件不会推断公共主机名或部署预算。配置缺失、非规范、非正数、非安全整数、定时器溢出或约束不一致都会使激活失败。

| 字段 | 含义 |
|---|---|
| `httpsOrigin` | 真实且规范的 HTTPS 源；不含凭据、路径、查询、片段或末尾斜杠。 |
| `maxConnections`, `maxConnectionsPerIp` | 全部已准入 socket，包括匿名 socket。 |
| `maxPending`, `maxPendingPerIp` | 完成证明前尚未认证的 socket。 |
| `maxRoutes`, `maxRoutesPerIp` | PC 名额，包括 PC 路由上的匿名 socket。 |
| `maxPhones`, `maxPhonesPerIp`, `maxPhonesPerPc` | 手机名额；目标 PC 的限制包含待完成挑战。 |
| `maxIpBuckets`, `ipBucketTtlMs` | 保留的传输源 IP 桶及其非活动过期时间。 |
| `maxFrameBytes` | 完整收发 UTF-8 JSON 的字节上限，包含元数据。 |
| `maxOutboundQueueBytes`, `maxChannelQueueBytes` | 每 socket 及每通道方向的在途字节；慢接收端会被终止。 |
| `bytesPerSecond`, `bytesPerSecondPerIp`, `bytesPerSecondPerSocket` | 字节令牌桶容量及每秒补充量；收发字节均计入。 |
| `upgradesPerWindow`, `upgradesPerWindowPerIp`, `upgradeWindowMs` | 全局/IP upgrade 令牌桶，包括 authority 被拒绝的请求。 |
| `registrationTimeoutMs`, `challengeTimeoutMs`, `channelHandshakeTimeoutMs` | 注册、证明和端点握手期限。 |
| `idleTimeoutMs`, `maxConnectionLifetimeMs`, `sweepIntervalMs` | 应用非活动期限、socket 绝对生命周期及过期扫描间隔。 |

代理必须保留配置的精确公共 Host 与两条精确路径。若存在 Origin，它必须等于 `httpsOrigin`；原生客户端可不提供 Origin，且 Origin 永远不是身份认证。重复 Host/Origin 头、查询字符串、路径后缀、二进制消息、无效 JSON、未知字段/类型/版本、重复证明及过时 socket generation 都会关闭传输。

relay 只使用 `request.socket.remoteAddress`，忽略转发 IP 头。因此同机代理的所有客户端共享一个 IP 桶。上游必须独立设置客户端 IP 配额、HTTP 头/请求大小限制、连接/upgrade 限制、字节/帧/分片速率、TLS 握手限制及读写期限。不要直接暴露 loopback HTTP 后端，也不要将 TLS 终止当作端到端授权。

### MANUAL 部署验收 — 未执行

父级完成 profile 注册及依赖集成后，部署负责人必须针对其真实 HTTPS 源进行下列检查。这是验收清单，不是已执行部署的证据。

1. 验证有效证书、精确公共 Host 保留、精确 upgrade 路径及后端仅可由托管代理访问；验证上游头、分片、连接、字节速率、TLS 和超时限制。
2. 验证原生客户端不带 Origin 时成功，恶意 Origin/Host 和非精确路径失败，未知/离线 PC 失败，伪造转发 IP 头无法绕过传输源配额。
3. 验证双方的新鲜规范 P-256 SPKI/DER SHA256withECDSA 证明；拒绝过期、复制到其他 socket、篡改源/目标/密钥/角色及重放的证明。拒绝重复在线 PC，且不替换当前所有者。
4. 验证已认证手机元数据及绑定 hello 只到达所选 PC；验证 PC 拒绝未授权配对/授权记录及已撤销授权。验证双方在应用派发前拒绝被修改或重放的加密记录。
5. 耗尽每项显式准入/速率/保留上限；确认非活动匿名 IP 桶会过期。暂停读取，验证每通道/方向及每 socket 的字节上限会终止连接而不进行离线交付。
6. 通过 Loader 重载/释放 relay；验证两项注册消失，全部 socket/回调结束，重连产生新 generation、挑战、密钥和计数器。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节 — 点击展开</summary>

[插件](src/index.ts) 负责一项可撤销的 upgrade 注册 effect。[relay](src/relay.ts) 在解析密钥前预留全局与 IP 名额，在验证证明前消费唯一保留的挑战，且只保留实时 socket、PC 路由、通道、队列计数及可过期 IP 令牌桶。每条 PC 路由只有一个规范身份所有者；不存在运维 allowlist。手机首个绑定 hello 创建其唯一通道，并向 PC 发送已认证身份/generation 元数据。后续帧无法选择目的地或广播。

[路由解析器](src/wire.ts) 只接受角色对应的控制操作及共享 hello/welcome/encrypted JSON 解析器。relay 检查路由身份及 generation，但不会解密密文或解释配对授权记录。[共享协议参考](../../util/companion-protocol/README.zh.md#wire-reference) 负责加密编码、transcript 及端点消息。释放时先移除两条路由，再终止 socket，等待关闭/send 回调结束，并在删除实时所有者前比较连接/通道对象。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [独立 relay bundle](../../bundle/companion-relay/README.zh.md) — profile 组合及显式环境配置。
- [共享 companion 协议](../../util/companion-protocol/README.zh.md) — 规范身份认证证明及加密端点消息。
- [Webserver](../webserver/README.zh.md) — 精确 upgrade 注册表及传输所有权。
- [架构](../../../docs/architecture.zh.md) — 支持的 profile 启动与组合。

-----

<a id="model-experience"></a>
## 模型体验

无；此包转发密文，不引入 agent、session、工具、提示词、schema 或模型可见消息。

#### KV Cache 影响

无；此包从不组装或发送 provider 请求。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- relay 状态仅在进程内实时存在：没有离线队列、任务存储、session ledger、持久化或多实例会合。PC 断线会关闭全部绑定手机；HMR/重启需要新的端点握手。
- 认证证明的是密钥持有权，不是配对或权限。PC 必须实施授权记录及撤销；relay 无法发现密文内的端点滥用。端点负责拒绝加密记录重放。
- 原生 ping/pong 控制流量会终止 socket，不延长非活动期限；客户端与代理必须依赖应用流量及配置期限，而非 WebSocket ping 保活。由于有意忽略转发 IP，代理可见的客户端身份必须在上游设置配额。
- 已提供源代码组合回归，但尚未执行。实时 HTTPS 验收、类型检查、文档配对/检查、包解析及构建产物仍未验证；不声明已部署或生产就绪。

<a id="dev-note"></a>
### 开发笔记

<details>
<summary>维护者工作上下文 — 点击展开</summary>

无。

</details>
