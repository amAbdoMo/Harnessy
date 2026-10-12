# Companion 应用 JSON v1

[English](APPLICATION.md) | 中文

## 概述

本文规定 [application.ts](src/application.ts) 解析的纯文本应用消息。消息只能在加密密钥确认后传输；PC 连接器负责授权与执行。连接器不得将消息转发为任意操作员 RPC 调用。

## 目录

- [请求与结果](#requests-and-results)
- [编码与限制](#encoding-and-limits)
- [PC 入队与读取所有权](#pc-admission-and-read-ownership)
- [手动验收](#manual-acceptance)

## Requests and results

每个对象具有 `v:1`，且只能包含列出的字段。问号表示可选字段；省略意味着不存在，而非 `null`。请求使用 `requestId` 关联，不使用 Gateway RPC ID。表中的字段顺序仅用于阅读：应用 JSON 按实际传输字节加密，不作为规范 JSON 表示签名。

| 请求 `type` | `v,type,requestId` 后的字段 | 结果 `type` | `v,type,requestId` 后的字段 |
|---|---|---|---|
| `listSessions` | `cursor?,limit` | `sessions` | `sessions,cursor?` |
| `readHistory` | `sessionId,cursor?,limit` | `history` | `sessionId,rows,cursor?` |
| `watchProgress` | `sessionId,cursor?` | `watching` | `sessionId,subscriptionId` |
| `submitText` | `sessionId,text,submissionId` | `submitted` | `sessionId,submissionId,admission:"inMemoryInbox"` |
| `cancelRead` | `subscriptionId` | `cancelled` | `subscriptionId` |

请求也可返回 `{v:1,type:"error",requestId,code}`，其中 `code` 只能是 `denied`、`notFound`、`limit`、`expired` 或 `unavailable`。实时读取发送 `{v:1,type:"progress",subscriptionId,sessionId,rows,status,cursor?}`，不包含请求 ID。手机接受结果前必须将结果类型、请求 ID、Session ID，以及提交或订阅 ID 与未完成操作关联；仅解析消息不能建立这种关联。

每条 Session 摘要仅包含 `sessionId,title,status`；`status` 为 `idle`、`queued`、`running` 或 `closed`。每条历史行仅包含 `role,seq,id,text`；`role` 为 `user`、`assistant`、`tool` 或 `notice`。工具行包含经批准的有界文本，不包含工具参数或任意结果投影。每批历史和进度行必须具有严格递增的序号及不重复的 ID。PC 和手机还必须使用 PC 签发的游标保持跨订阅批次的顺序。

输入示例；生产环境应以新生成的请求 ID 替换示例中的全零值：

```json
{"v":1,"type":"readHistory","requestId":"AAAAAAAAAAAAAAAAAAAAAA","sessionId":"session-1","limit":20}
```

收件箱接纳确认示例；这不是完成回执：

```json
{"v":1,"type":"submitted","requestId":"AAAAAAAAAAAAAAAAAAAAAA","sessionId":"session-1","submissionId":"AQEBAQEBAQEBAQEBAQEBAQ","admission":"inMemoryInbox"}
```

## Encoding and limits

JSON 使用格式正确的 Unicode，并按 UTF-8 编码。解析器拒绝不支持的版本、操作、字段、值为 `null` 的可选字段、孤立代理项和错误标识符。纯文本可以包含用户输入的网址文字，但协议没有网址、附件、文件、终端、审批或设置字段。原生 UI 必须按文字渲染，不执行 HTML，也不激活任意链接。

`requestId`、`submissionId` 和 `subscriptionId` 是恰好 16 字节的规范无填充 base64url 编码。生产调用者生成新的随机 ID。Session ID 和历史行 ID 为 1–128 字节的 ASCII 标记，匹配 `[A-Za-z0-9][A-Za-z0-9._:-]*`；PC 拒绝无法表示其 ID 的现有 Session，而不创建别名。`seq` 是恰好八字节的无符号大端序数值，以规范 base64url 编码，不能使用 JSON 数字。`cursor` 是 1–256 字符的规范无填充 base64url 文本；签发它的 PC 验证其作用域与含义。

移动应用 JSON 的固定上限为 49,152 UTF-8 字节，包含所有包装、行、ID、标题和游标。`parseApplicationBudget` 要求下面的全部字段，拒绝未知字段，并返回冻结的部署预算。完整请求与结果编码器在加密前使用相同解析器；超限结果必须分页或拒绝，不得截断为无效 JSON。密码帧及中继封装预算独立计算，并必须容纳 base64 扩展与路由元数据。

| 预算字段 | 有效闭区间 | 执行者 |
|---|---|---|
| `maxRequestBytes,maxResultBytes` | 512–49,152 | 应用解析器与编码器 |
| `maxTextBytes` | 1–49,152，加 256 后必须适配两个字节上限 | 应用解析器与编码器 |
| `maxTitleBytes` | 1–1,024，加 256 后必须适配结果字节上限 | 应用解析器与编码器 |
| `maxRows,maxSessions` | 1–256 | 应用解析器与编码器 |
| `maxSubscriptionsPerGrant,maxPendingSubmissionsPerGrant` | 1–64 | PC 连接器在保留状态或接纳前 |
| `readTimeoutMs` | 100–60,000 | PC 连接器针对每次读取 |
| `subscriptionLifetimeMs` | 1,000–3,600,000 | PC 连接器针对每项订阅 |

列表与历史请求必须提供 `limit`，其范围为 1 至配置中的对应数量上限。有效预算不保证最大行数能适配字节上限；完整编码结果才是权威大小检查。配置要求的 256 字节余量用于发现不可用预算，并不保证所有最大字段都能适配。

## PC admission and read ownership

PC 连接器必须在每次分派时授权认证授权记录及其当前代次，将订阅与游标绑定到该授权和 Session，在撤销或断线时取消它们，并在每授权限制之外限制进程总保留量。本库不执行配对、身份信任、Session 选择、进度投影或收件箱接纳。

`submitText` 表示向现有 Session 提交一个固定排队后续消息。它不能创建 Session、引导活跃请求、选择模型、改变审批或附加内容。提交标识符的作用域为 `(authenticated phone grant, sessionId, submissionId)`，不是全局操作员命令标识符。PC 必须串行执行接纳决策，并在有界实时接纳窗口内拒绝标识符的冲突复用。只有内存收件箱接受文本后，PC 才可发送 `submitted`。

成功确认仅报告易失性接纳：PC 随后可能丢弃未启动输入、发生故障或重启而不执行输入。确认丢失意味着**送达情况未知**，即使手机保留了提交 ID。没有回执查询端点、持久提交账本或自动变更重试，包括重连后。用户可以显式选择新提交，但必须收到可能重复执行的警告。读取重试需要新的请求 ID 和新授权的加密连接；订阅不会跨 socket 代次存活。

## Manual acceptance

本次有界源码工作没有执行任何应用操作或回归源码。启用前，父任务必须集成 PC 消费者和原生 Android 对端，对 [application-types.ts](src/application-types.ts) 的使用进行类型检查，并运行 [application.spec.ts](tests/application.spec.ts) 的源码回归。验证数量和完整 UTF-8 字节边界、元数据拒绝、请求与结果关联、授权撤销、订阅释放、收件箱拒绝、实时重复 ID，以及确认丢失后的送达未知行为。Android 原生 UI 与 APK 源码属于独立工作，本库不提供 PWA。

### Dev Note

无。
