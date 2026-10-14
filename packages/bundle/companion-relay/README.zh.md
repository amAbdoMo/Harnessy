---
description: "组合独立的实时密文 relay profile，显式指定 HTTPS 部署身份及预算，不包含 agent 或模型 provider。"
kind: "package-bundle"
---

# @deepseek-ai/dsh-companion-relay-bundle

[English](README.md) | 中文

## 概述

专用 profile 可在托管 TLS 反向代理后提供有界的实时 companion 密文转发。PC 使用规范身份自行注册，手机只能到达其所选的在线 PC。此层不包含 agent、session、provider 配置、PC 登录 token 或通用 gateway。部署身份及每项 relay 预算都必须显式提供。

## 目录

- [使用此包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用此包

[manifest](package.json) 声明 `dsh.bundle.patch`；这是 profile 层，不是原始 Node 应用或 package 可执行文件。支持的启动器为 `dsh --profile companion-relay`。父级集成必须注册此模板、CLI 依赖、源代码 alias、聚合项目、依赖锁定条目及 package 分类，profile 才可用。不要在 `dsh-base` 或其他应用 bundle 上叠加此 bundle。

### MANUAL profile/部署验收 — 未执行

下列命令标明 profile 入口及可选的层管理操作。它们尚未运行；不要将其视为安装、部署或验证证据。部署负责人必须先完成父级集成、package 解析及托管 TLS 代理配置。

```text
# MANUAL only: inspect the profile-owned grammar after integration.
dsh --profile companion-relay --help
# MANUAL only: start with operator-supplied bind environment and all relay budgets.
dsh --profile companion-relay
# MANUAL only: optional layer management in this dedicated standalone profile.
dsh plugin --profile companion-relay add @deepseek-ai/dsh-companion-relay-bundle
dsh plugin --profile companion-relay remove @deepseek-ai/dsh-companion-relay-bundle
```

profile 只负责 `--host`、`--port` 和 `--help`。`--host` 必须显式为 `127.0.0.1`；否则设置 `DSH_COMPANION_RELAY_BIND_HOST=127.0.0.1`。通过 `--port` 或 `DSH_COMPANION_RELAY_BIND_PORT` 提供 0 至 65535 的整数。不打开浏览器，不打印带凭据的 URL。同机反向代理必须终止 TLS 并保持 HTTP 后端私有；不支持直接暴露后端。

将 `DSH_COMPANION_RELAY_HTTPS_ORIGIN` 设置为部署实际的规范 HTTPS 源。不存在示例主机名 fallback。每个数值字段都显式提供：[patch](cordis.patch.yml) 列出了各项 [relay Config 字段](../../host/companion-relay/src/config.ts) 对应的精确 `DSH_COMPANION_RELAY_*` 环境变量。缺失或无效值会使激活失败。更高层 profile/home/invocation patch 可以替换某行的完整 config，而不读取这些变量；必须保留 startup gating 并提供全部 relay 字段。

部署验收前，应针对真实源执行 relay 的 [MANUAL 部署清单](../../host/companion-relay/README.zh.md)，包括证书/Host/路径、上游配额、双方身份证明、PC 所有的授权、加密记录篡改/重放拒绝、慢接收端终止及静默完成的 Loader 重载。这些检查必需，且尚未执行。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节 — 点击展开</summary>

[完整 patch](cordis.patch.yml) 只插入 profile 的 [startup 解析器](src/startup.ts)、loopback [webserver](../../host/webserver/README.zh.md) 及[密文 relay](../../host/companion-relay/README.zh.md)。startup 解析器仅在接受命令后公布绑定值；webserver 与 relay 行注入这个信号，因此帮助/拒绝不会启动传输。不继承 `dsh-base`、timer 服务、模型 adapter、应用 Session 或存储行。relay 自行负责 effect 绑定的定时器。按顺序应用的 profile/home/invocation patch 仍然进行普通的完整行覆盖。

此包导出无运行行为的 bundle 入口及具名 `/startup` 插件。workspace tsdown Host 阶段使用 TypeScript 生成的 `index` 和 `startup` 入口；不存在新启动器或 package bin。[共享 companion 协议](../../util/companion-protocol/README.zh.md#wire-reference) 是加密编码及端点消息定义的唯一所有者；relay 包负责传输限制及易失路由。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [Relay 插件](../../host/companion-relay/README.zh.md) — 预算、状态所有权及手动 HTTPS 验收。
- [共享 companion 协议](../../util/companion-protocol/README.zh.md) — 规范认证及加密参考。
- [架构](../../../docs/architecture.zh.md) — profile 层与支持的启动方式。
- [最小 SDK bundle](../sdk-minimal/README.zh.md) — 另一个独立组合的应用树。

-----

<a id="model-experience"></a>
## 模型体验

无；此独立 bundle 不插入 agent、session、工具、提示词、schema 或模型 provider 插件。

#### KV Cache 影响

无；组合后的 relay 从不组装或发送 provider 请求。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- bundle 依赖外部托管 TLS 及独立的上游客户端 IP、HTTP/头、连接、分片/帧/字节速率、TLS 握手和超时限制。转发头无法建立 relay 源身份；同机代理共享其 relay IP 配额。
- 只提供进程内在线路由；不含离线任务队列、存储、session ledger 或分布式会合。身份认证不替代 PC 所有的配对、授权记录或撤销。
- profile 注册及仓库级集成属于父级修改。本任务没有执行安装、应用、服务器、测试、构建、文档配对/检查、网络操作或实时部署验收。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

无。

</details>
