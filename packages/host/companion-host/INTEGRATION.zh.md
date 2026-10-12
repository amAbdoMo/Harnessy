# Companion Host 集成参考

[English](INTEGRATION.md) | 中文

## 仅交付源码

Desktop 使用私有所有者能力和真实部署配置挂载此可选服务。启用前须验证运行时安全、Windows 所有权及实体 Android 互操作；静态检查不提供这些证据。源码准备不会更改已安装凭证数据，也不提供已托管中继来源。

## 桌面所有权与原生控制

默认导出为 `CompanionHost`，注册为 `ctx.companionHost`；它不是 Typert Remote 服务，也不注册 HTTP 路由。Desktop Host 的 `runProfile.prepare` 使用实际凭证 home 和父进程断连或 Host 退役时同步中止的信号调用 `installDesktopCompanionOwner(ctx, { home, signal })`。能力附属于该应用的根上下文；YAML 不能提供该能力。无此能力挂载已配置服务会失败。服务在 `<canonical-home>/.companion-host-owner` 持有内核锁，直至静止处置完成：Windows 保持零共享的 `CreateFileW` 句柄；POSIX 保持独占 `flock`，并核验当前 inode。拒绝重复所有者，不按心跳到期夺取所有权、不探测 PID，也不删除过期文件。进程死亡会关闭内核句柄；释放仍保留 POSIX 锁 inode。

仅 main 的原生消费者调用 `describe()`、`createInvitation()`、`approveCandidate(candidateId, confirmFingerprint)`、`cancelInvitation()` 和 `revokeGrant(grantId)`。`describe()` 向 Main 提供 `available`、`connected`、公开 `pcId`、配对标签、邀请 id/过期时间及候选 id/指纹/空显示名称。Main 仅向渲染进程投影可用性、连接状态和配对数量；候选与授权标识符仅供私有原生管理使用。`createInvitation()` 仅向已认证 Desktop main 返回 `{ invitationId, expiresAt, pairingUrl }`。main 使用剪贴板能力复制 `pairingUrl`，不向渲染进程返回任何含秘密的值。main 验证所属主窗口顶层帧调用者，校验 IPC 参数，并将相关回复绑定于当前 Host 实例。不使用旧 PC 启动令牌。

批准要求准确的本地候选 id 和准确的小写 SHA-256 指纹。取消在等待排队管理操作前立即中止正在提交的候选。撤销立即中止所有受影响通道的授权信号，然后删除已存储行并等待拆除。凭证写入失败会拒绝撤销完成，但旧信号保持撤回。本地 UI 必须说明后续文本可以执行现有 PC 任务或工具权限，不能暗示手机具有工具批准能力。

## 固定的原生链接编码

版本一原生链接准确为 `harnessy://pair#<base64url>`，没有路径后缀、查询参数或网页 JavaScript 要求。片段是以下公开字段顺序的 UTF-8 `JSON.stringify` 内容的规范无填充 base64url。JSON 对象成员顺序不赋予密码学权限；Android 必须在存储邀请前验证准确成员集合、值类型、规范来源或公钥或 id 编码及过期时间。

```json
{"v":1,"httpsOrigin":"<actual canonical HTTPS origin>","pcIdentityKey":"<canonical public SPKI DER base64url>","pcId":"<SHA-256 PC id base64url>","invitationId":"<32 random bytes base64url>","expiresAt":0,"secret":"<32 random bytes base64url>"}
```

`expiresAt` 是整数 Unix 毫秒时间戳，不是示例中的零。`secret` 是新生成的 256 位邀请秘密，绝不是 PC 私钥或启动凭证。整个片段在过期或使用前都包含秘密；Android 不得记录、加入遥测或转发到网站。支持粘贴已足够；此包不使用二维码库，也不宣称提供二维码输出。

## 实际中继与端点协议

连接器仅打开 `wss://<actual-authority>/companion/pc`，使用实际规范 HTTPS `Origin`，无查询、重定向或压缩。原生手机使用 `/companion/phone`。双方发送包含 `role`、`identityKey` 和 `targetPcId` 的共享版本 `relay-register`；新的服务器 `relay-challenge` 使用共享 `signRelayChallenge` 辅助函数签署。客户端仅为其角色、目标和捕获的套接字代际接受 `relay-ready`。

PC 出站封装是 `{ v: 1, type: 'relay-data', channelId, socketGeneration, phoneSocketGeneration, payload }`；PC 关闭使用 `{ v: 1, type: 'relay-close', channelId, socketGeneration, phoneSocketGeneration }`。入站 open/data/close 通知使用[连接器解析](src/connector.ts)和[中继转发](../companion-relay/src/relay.ts)中的当前准确字段。中继来源声明仅用于路由检查。Host 独立验证共享签名 hello 是否匹配固定 PC 公钥及来源，验证手机密钥持有和邀请 HMAC 或当前授权代际，并使用共享 `acceptClientHello` 推导 ECDH/welcome/channel。本地批准与凭证提交前不发送 welcome。

双方在应用字节前交换共享加密密钥确认。签名 welcome 绑定完整签名 hello 及 PC 签发的授权 id/代际；Android 连同自身身份密钥存储这些公开值。共享协议当前没有独立的持久签名授权证明消息。此消费者不自行发明：Android 必须支持当前绑定 welcome 的注册格式，或与协议负责人协调明确的共享协议变体。恢复的手机副本绝不能替换 PC 授权行。

应用请求或结果使用共享[应用类型](../../util/companion-protocol/src/application-types.ts)及解析器或编码器，不使用操作员 RPC。封闭操作为 `listSessions`、`readHistory`、`watchProgress`、`submitText` 和 `cancelRead`。不存在回执端点。手机提交 id 在映射至现有 Session 请求 id 前，以已认证授权及 Session 建立命名空间。完整 UTF-8 请求、结果和协议大小、发送排队字节、通道尝试、候选、授权、订阅与待处理操作都由显式配置限制。

## 凭证存储

现有凭证键准确为 `companion-host/identity`，记录封装为 `{ kind: 'grant', payload }`。负载成员集合为 `{ v: 1, httpsOrigin, pcId, identityPublicKey, identityPkcs8, grants }`。`identityPkcs8` 是 P-256 私钥 PKCS#8 DER 的规范无填充 base64url；`identityPublicKey` 是公开 SPKI DER 的规范 base64url。每个授权为 `{ grantId, generation, phoneIdentityKey, displayName, pairedAt }`，其中 `pairedAt` 为整数 Unix 毫秒，`displayName` 当前为空。此负载是私有数据，不得跨越公开 IPC 或渲染进程桥接。

[记录](src/records.ts)拒绝额外成员、版本或密钥或 id 或曲线或来源不匹配、超大记录、无效代际和重复手机密钥或授权 id。仅首次启动缺失允许生成身份。运行中记录删除、损坏或身份替换绝不静默重新生成；功能撤回并要求本地处理。端点变更要求本地重置与重新配对。重置是本地维护操作：在删除旧身份记录前先退役旧 Host 并撤回全部手机权限，再以新来源启动。复制凭证会克隆身份，包括本地锁无法保护的不同 home。

写入使用 `CredentialProvider.modifyRecord`，其本地实现持现有跨进程文件锁重新读取。不引入新数据库。任何记录更新事件都在异步重新加载前同步中止已注册通道信号。唯一正在提交的候选在自身存储提交期间没有应用权限，必须在 welcome 前重新读取当前记录；赋予授权后，每次记录变更也中止它。Credentials-local 在底层来源故障后保留最后有效读取缓存，但永久中止 `sourceFailureSignal` 并发出无负载的 `credentials/source-failed`；伴随功能检查初始健康状态，并在该事件中同步撤回权限。其原子写入器还缺少 fsync 与 Windows ACL 验证；不得宣称更强的持久性或权限保证。

## 父任务集成要求

- 将新包及共享协议加入根依赖解析、源码 `paths`、host/test 编译器聚合和构建或打包发现；仅由父任务授权安装依赖。包内引用与依赖分类见[清单](package.json)和[编译器配置](tsconfig.json)。
- 提供 `ws` 8.21.0 及声明的类型包、用于 Windows 句柄的 `koffi` 3.1.1，以及用于 POSIX `flock` 的工作区原生系统包。协议、品牌和配置辅助函数为运行时依赖；现有 Cordis 能力负责人为 peer 依赖，并有开发依赖对应项。测试源码审查后必须核对测试组合依赖。
- 仅在桌面拥有的 Host 中挂载，提供每个已验证预算和真实部署来源，使旧公开 PC 或操作员访问不进入伴随功能，并接入原生控制、私有剪贴板 IPC、本地化公开状态和警告。
- 使用仅供 Host 调用的 `SessionController.admitPrompt(request, admissionCheck)` 方法。其回调在异步解析后及紧邻收件箱插入前同步检查。回调必须检查可撤销通道信号与当前授权，并使用 `RemoteError('gateway/cancelled', ...)` 拒绝；只在 await 前读取一次并不足够。
- Android 必须实现此准确链接、中继封装、共享域隔离密码学、密钥确认、当前授权重连及封闭应用操作或结果集合。仅在共享协议中添加签名显示名称元数据或本地 PC 操作状态，绝不能在这里复制未声明的模式。
- 验证原生 Windows ACL 行为、锁失效或重复所有权、慢速发送拆除、重放或错误 UTF-8 拒绝、授权删除或代际竞争、不激活的冷历史读取、完整字节预算及送达未知处理。补充组装后的转录和 Desktop/Android 端到端证据。本次交付不运行上述操作。
