---
description: "PC/手机认证通道与全新中继密钥持有证明，附带冻结的 Java 兼容二进制线协议参考。"
kind: "package-library"
---

# dsh-companion-protocol

[English](README.md) | 中文

## 概述

调用方可以认证 PC/手机握手、交换完成密钥确认的加密字节，并向中继证明身份密钥的持有权。Node 原生加密提供 P-256、SHA-256、HMAC、HKDF 和 AES-GCM，不依赖第三方加密库。线协议参考定义 Android Java 实现必须复现的字节。调用方负责配对、授权记录、身份存储、传输以及所有应用授权决策。

## 目录

- [使用此包](#use-this-package)
- [线协议参考](#wire-reference)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延后工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用此包

这是仅限 Node 的库依赖，不是配置档案、Cordis 插件、传输层、中继或授权服务。导入[入口模块](src/index.ts)；[握手 API](src/handshake.ts) 返回尚未确认的通道，[中继 API](src/relay-auth.ts) 仅证明密钥持有权。

手机使用 `createPhoneHandshake`，并提供已固定的 PC 身份与已验证的源。PC 在查询自己的邀请/授权存储前使用 `verifyClientHello`，随后向 `acceptClientHello` 传入匹配的显式决策。手机通过 `complete(welcome)` 一次性消耗本次尝试。每次尝试创建新的随机数和临时密钥；重连从不恢复密钥或计数器。

双方在发送应用字节前调用 `sendConfirmation`。在双向确认完成前，`receive` 返回不含可分发明文的 `kind: 'confirmation'`；只有 `kind: 'application'` 携带应用字节。一个队列串行执行加密、本地传输写入结算和解密。传输回调必须在不等待对端确认、也不调用同一通道的情况下结算，否则可能造成队列死锁。不要修改已排队的线消息对象；出站明文在排队前复制。调用方在解析前限制队列深度和原始 JSON 大小。

PC 必须原子地预留/消耗有效邀请、核对目标 PC/源及过期时间、验证配对密钥、分配/持久化授权记录，并在将通道视为已授权前阻止并发重复签发。授权重连时，PC 检查手机身份、当前代次、权限、有效期和撤销状态。库验证调用方决策与签名引用匹配；它从不创建授权决策。调用方在每次应用分发前重新检查当前授权，并关闭已撤销通道。调用方验证邀请回执并处理回执缺失；回执存在与否不是库的信任决策。

中继按确切的待认证套接字代次保存每个挑战、限制其生命周期，并原子地消耗一次。它针对存储的挑战验证证明，而不是使用证明方附带的挑战。签名客户端在签名前检查预期角色、规范源、目标 PC 和套接字代次。有效中继证明或路由至 PC 均不授予配对或操作权限。

-----

<a id="wire-reference"></a>
## 线协议参考

本节冻结版本一的线字段、顺序、编码和加密输入。JSON 对象属性顺序无关紧要；认证二进制字段的顺序不可改变。解析器拒绝缺失/额外字段、其他版本/套件/角色以及非规范二进制编码。调用方只解码 JSON 一次，并在这些解析器之前拒绝过大的原始消息。

### 应用导航兼容性

`listSessions` 接受可选的 `view: 'navigation'`。省略时，每行仍恰好包含 `sessionId`、`title` 和 `status`；选择导航视图后增加 `navigation`，其中恰好包含 `updatedAt`、`pinOrder` 和 `workspace`。`workspace` 为 `null` 或恰好包含 `{id, title, order}`；未置顶时 `pinOrder` 为 `null`。所有导航数值均为 `[0, Number.MAX_SAFE_INTEGER]` 内的整数。[应用类型](src/application-types.ts)与[解析器](src/application.ts)负责这些字段；导航不授予修改权限。

不支持此扩展的 PC 会拒绝额外请求字段并关闭通道。使用请求此视图的手机前，必须先更新 PC；不得放宽精确字段解析，也不得通过宽松回退重试。省略 `view` 的旧手机仍接收原有响应。参见[升级指南](../../../docs/upgrade-guide/v0.1.15/companion-navigation/guide.zh.md)。

<a id="application-management-compatibility"></a>
### 应用管理兼容性

封闭的[应用请求／结果类型](src/application-types.ts)新增受权限控制的 `listManagementWorkspaces` 和四条命令：`createSession`、`renameSession`、`archiveSession` 与 `setSessionPinned`。目录以 ID、标题和顺序包含已注册的空 Workspace，绝不包含 PC 路径；普通 Session 列表仍省略空分组。精确字段解析不接受通用 RPC、提供方秘密或 Delete 操作。创建将手机预先知道的 Session ID 绑定为 `mobile-${operationId}`；置顶使用明确的目标布尔值，而非切换。`managed` 区分 `applied`、确定的 `rejected` 和 `unknown`；操作 ID 是单次关联标识，不是持久重放键。PC 许可与完成语义归[Host 集成](../../host/companion-host/INTEGRATION.md)所有；请遵循[PC 优先升级指南](../../../docs/upgrade-guide/v0.1.15/companion-chat-management/guide.zh.md)。

### 基础编码

`LP(x)` 为 `uint32BE(byteLength(x)) || x`，不带终止符。`C(domain; fields...)` 为 `LP(UTF8(domain)) || LP(field1) || ...`。普通文本字段使用确切 UTF-8。十进制字段使用无前导零的最短无符号 ASCII 十进制。下文原始字段使用解码后的字节，而非 base64url 文本。嵌套转录作为一个原始字段，包含其所有内部长度前缀。任何认证转录都不包含 JSON 序列化、空白、排序、Unicode 规范化或分隔符拼接。

所有二进制 JSON 字段使用无填充的规范 base64url，字符集为 `A-Z a-z 0-9 _ -`，未使用的尾部位为零，不允许空白。身份与临时公钥必须为恰好 91 字节的规范 DER SPKI，算法为 `id-ecPublicKey`，命名曲线为 `prime256v1`/`secp256r1`，使用未压缩点。固定的 27 字节前缀为 `3059301306072a8648ce3d020106082a8648ce3d03010703420004`。原生密钥导入验证点；重新导出的每个字节必须相同。PEM、私钥、显式参数、其他曲线、压缩点、畸形点和尾随字节均被拒绝。双方身份签名均使用 SHA-256 与 ECDSA，以及规范 ASN.1 DER `(r,s)`；标量必须位于 `[1,n-1]`。同时接受 high-S 和 low-S 签名；不接受 IEEE-P1363。Node 默认 DER 签名对应 Java JCA `SHA256withECDSA`，而不是 `SHA256withECDSAinP1363Format`。

`pcId = base64url(SHA256(C('dsh-companion/pc-id/v1'; rawIdentitySPKI)))`。不透明通道/授权/邀请/套接字标识符匹配 `[A-Za-z0-9_-]{1,128}`，并使用不同的 `dsh-brand` 类型。PC id 还必须解码为恰好 32 字节。`generation` 为 `[1,4294967295]` 内的 JSON 整数；认证的代次字段使用十进制文本。`httpsOrigin` 必须与 `new URL(text).origin` 完全相等，使用 HTTPS，且不含凭据、路径、尾斜杠、查询或片段。规范拼写并不证明源所有权或可达性。

### 确切 JSON 字段

每行按展示顺序列出完整字段集；标记为二进制的值使用上述基础编码。

| 消息 | 字段 |
|---|---|
| 手机 hello | `v:1`、`type:'hello'`、`suite:'P256-SHA256-HKDF-A256GCM'`、`role:'phone'`、`httpsOrigin`、`channelId`、`phoneIdentityKey`（SPKI）、`pcIdentityKey`（SPKI）、`nonce`（32 字节）、`ephemeralKey`（SPKI）、`authorization`、`pairingProof`、`signature`（DER）。 |
| 授权引用 | `kind:'grant'`、`grantId`、`generation`。`pairingProof` 为空字符串。 |
| 邀请引用 | `kind:'invitation'`、`invitationId`。`pairingProof` 为 HMAC-SHA256，32 字节。 |
| PC welcome | `v:1`、`type:'welcome'`、固定 `suite`、`role:'pc'`、`channelId`、`nonce`（新的 32 字节）、`ephemeralKey`（新的 SPKI）、`grantId`、`generation`、`signature`（DER）。 |
| 加密帧 | `v:1`、`type:'encrypted'`、`direction`、`channelId`、`grantId`、`generation`、`counter`（8 字节）、`ciphertext`、`tag`（16 字节）。 |
| 中继挑战 | `v:1`、`type:'relay-challenge'`、`role:'pc'` 或 `'phone'`、`httpsOrigin`、`identityKey`（SPKI）、`targetPcId`（32 字节）、`socketGeneration`、`challenge`（新的 32 字节）。 |
| 中继证明 | `v:1`、`type:'relay-proof'`、`signature`（DER）。 |

### 握手转录

下方所有域字符串都是确切 ASCII。`V` 为 UTF-8 `1`；`S` 为 UTF-8 `P256-SHA256-HKDF-A256GCM`。即使 JSON `type` 没有单独编码，域与已验证的固定字段也绑定了消息类型。

| 名称 | 确切字节 |
|---|---|
| `U`（未签名 hello） | `C('dsh-companion/hello/v1'; V, S, 'phone', httpsOrigin, channelId, rawPhoneIdentitySPKI, rawPcIdentitySPKI, rawPhoneNonce32, rawPhoneEphemeralSPKI, authorizationFields...)`。 |
| 授权字段 | `'grant', grantId, decimal(generation)`。 |
| 邀请字段 | `'invitation', invitationId`。 |
| 配对证明 `P` | 邀请使用 `HMAC-SHA256(secret32, U)`；授权使用空字节。密钥从不传输。 |
| 手机签名输入 `H` | `C('dsh-companion/hello-signature/v1'; U, P)`。 |
| 已签名 hello `HS` | `C('dsh-companion/signed-hello/v1'; H, rawPhoneSignatureDER)`。 |
| PC 签名输入 `W` | `C('dsh-companion/welcome-signature/v1'; HS, V, S, 'pc', channelId, rawPcNonce32, rawPcEphemeralSPKI, grantId, decimal(generation))`。 |
| 转录哈希 `T` | `SHA256(C('dsh-companion/transcript/v1'; W, rawPcSignatureDER))`。 |

手机签名绑定配对证明和每个未签名 hello 字段。PC 签名绑定双方身份密钥、授权引用、手机随机数/临时密钥/签名/证明以及每个 welcome 字段。手机验证已固定 PC 密钥与确切 hello 元组，包括授权重连时的授权 id/代次。失败或成功的 welcome 完成都会消耗待完成手机尝试；`close()` 同样消耗它。签名 welcome 中的邀请授权由 PC 分配，不由手机提供。

### ECDH 与 HKDF

ECDH 使用新的 P-256 临时密钥对与对端已验证 SPKI。其输入密钥材料 `Z` 为原始 32 字节 ECDH 共享 x 坐标，包含前导零。身份私钥不作为 ECDH 输入。`salt = SHA256(C('dsh-companion/hkdf-salt/v1'; rawPhoneNonce32, rawPcNonce32))`。

对每个方向 `D`（只能是 `phone-to-pc` 或 `pc-to-phone`），使用 `IKM=Z` 和此 salt 派生两个独立的 RFC 5869 HKDF-SHA256 输出：key32 使用 `info=C('dsh-companion/hkdf-info/v1'; T, D, 'aes-256-gcm-key')`、`L=32`；prefix4 使用 `info=C('dsh-companion/hkdf-info/v1'; T, D, 'aes-256-gcm-nonce-prefix')`、`L=4`。Java 可通过 JCA `HmacSHA256` 实现 RFC 5869；两个调用均不含 JSON 字节。不得在方向间共享密钥，也不得在重连时复用本次握手材料。

### AES-GCM、计数器与确认

每个方向从计数器 `0` 开始。线计数器为恰好八个无符号大端字节的 base64url 编码，绝不是 JSON 数字或十进制字符串。零为 `AAAAAAAAAAA`；uint64 最大值为 `__________8`。固定的每方向密钥使用上限为 1,048,576 次调用，包括确认：有效调用计数器为 `[0,1048575]`。不支持通道内换钥、计数器重置或恢复；耗尽是终止失败，必须重新握手。uint64 是编码范围，不是超出密钥使用上限的许可。

`nonce12 = keySpecificPrefix4 || uint64BE(counter)`。`AAD = C('dsh-companion/frame-aad/v1'; V, D, channelId, grantId, decimal(generation), rawCounter8)`。AES-256-GCM 使用完整的 16 字节认证标签加密，并将其分离到 JSON `tag` 字段；`ciphertext` 只包含加密载荷字节。首个载荷为 `0x00 || C('dsh-companion/key-confirmation/v1'; T, D)`。其后每个应用载荷为 `0x01 || applicationBytes`；应用字节可为空，上限为 65,536 字节。密文解析器允许最多 65,537 个解码字节，包括载荷类型字节，不包括 GCM 标签。

接收方要求确切的方向、通道、授权、代次和下一个计数器。在分类任何载荷或推进计数器前，它先验证 GCM。首个收到的载荷必须是该方向的确切确认。后续载荷要求本地确认已完成且具有应用类型标签。发送方仅在本地传输写入成功结算后推进计数器。任何解析、签名、HMAC、GCM、计数器/顺序、载荷/确认、超限发送或传输发送失败都会关闭相关尝试/通道；不得使用该密钥重试，也不得越过拒绝帧恢复。关闭会尽力清除自有对称缓冲区，并在当前本地写入结算后拒绝已排队操作；调用方必须另外关闭并等待其自有传输层。JavaScript 无法保证完整私钥或分配器内存清除。

### 中继认证

`R = C('dsh-companion/relay-proof/v1'; V, role, httpsOrigin, rawIdentitySPKI, rawTargetPcId32, socketGeneration, rawChallenge32)`。证明通过 DER `SHA256withECDSA` 对 `R` 签名。PC 角色还要求 `derivePcId(identityKey) == targetPcId`。新鲜性依赖于每次套接字认证尝试的新随机挑战，以及中继的一次性待处理挑战存储；签名验证本身无状态，不能阻止复用已存储挑战。中继认证密钥与通道身份密钥使用相同的规范公钥编码，但使用不同的转录域。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节 — 点击展开</summary>

[规范字节](src/bytes.ts)、[密钥验证](src/keys.ts)和[转录](src/transcripts.ts)定义可互操作的加密输入。[线解析](src/wire.ts)验证不可信的已解码 JSON。[握手](src/handshake.ts)对照显式的调用方授权决策检查证明持有权，随后派生尚未确认的[通道](src/channel.ts)。传输、应用编码、持久化、邀请消耗和实时授权检查均不属于这些模块。

[互操作生成器源码](tests/interop-vector.ts)返回固定测试标量 1–4、随机数字节 0–31/32–63、字节 `55` 重复 32 次的密钥、已签名消息、ECDH 输出、双向密钥/前缀、转录输入以及加密确认。ECDSA 签名为原生随机化值，因此每份生成夹具必须保留完整已签名消息及派生输出。Java 验证使用 `KeyFactory.getInstance("EC")` 与 `X509EncodedKeySpec`、`Signature.getInstance("SHA256withECDSA")`、`KeyAgreement.getInstance("ECDH")`、`Mac.getInstance("HmacSHA256")`，以及配备 `GCMParameterSpec(128, nonce12)` 的 `Cipher.getInstance("AES/GCM/NoPadding")`；JCA 的加密输出在末尾附加 16 字节标签。固定私钥标量是公开测试输入，不得成为生产身份。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

阅读[品牌化标识符](../brand/README.zh.md)和[仓库架构](../../../docs/architecture.zh.md)，了解类型所有权和组合。[应用消息](APPLICATION.md)的参考与本加密线格式分开。

-----

<a id="model-experience"></a>
## 模型体验

无，因为协议校验与加密不新增模型消息或工具；应用消费者负责所有模型可见效果。

#### KV 缓存影响

无直接影响；加密传输字节不会修改模型请求。

## 已知限制与延后工作

<a id="known-limitations-and-deferred-work"></a>

- 实现仅限 Node；Android/Java 必须独立复现本字节参考，并验证互操作夹具。
- 不提供传输、存储、重放缓存、邀请回执执行、配对/授权权限、权限检查、撤销通知、应用操作分发或确认回执语义。
- 调用方限制原始消息大小、握手尝试、队列深度、超时和授权有效期；库仅固定加密和已解码载荷上限。
- 源测试与互操作生成器需后续执行。此处不声称已进行编译、测试运行、夹具生成、Java 验证或文档检查执行。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

仓库集成负责聚合根、路径映射、锁文件/依赖分类、应用解析器/重导出以及双语配对登记。加密源码审查不能替代实际执行的跨运行时验证。

</details>
