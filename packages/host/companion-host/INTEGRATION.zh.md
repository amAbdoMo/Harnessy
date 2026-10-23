# Companion Host 集成参考

[English](INTEGRATION.md) | 中文

## 仅交付源码

Desktop 使用私有所有者能力和真实部署配置挂载此可选服务。启用前须验证运行时安全、Windows 所有权及实体 Android 互操作；静态检查不提供这些证据。源码准备不会更改已安装凭证数据，也不提供已托管中继来源。

## 桌面所有权与原生控制

默认导出为 `CompanionHost`，注册为 `ctx.companionHost`；它不是 Typert Remote 服务，也不注册 HTTP 路由。Desktop Host 的 `runProfile.prepare` 使用实际凭证 home 和父进程断连或 Host 退役时同步中止的信号调用 `installDesktopCompanionOwner(ctx, { home, signal })`。能力附属于该应用的根上下文；YAML 不能提供该能力。无此能力挂载已配置服务会失败。服务在 `<canonical-home>/.companion-host-owner` 持有内核锁，直至静止处置完成：Windows 保持零共享的 `CreateFileW` 句柄；POSIX 保持独占 `flock`，并核验当前 inode。拒绝重复所有者，不按心跳到期夺取所有权、不探测 PID，也不删除过期文件。进程死亡会关闭内核句柄；释放仍保留 POSIX 锁 inode。

[Desktop 启用负责人](../../../apps/desktop-host/src/companion-activation.ts)在挂载前验证单独保护的 `companion-host/desktop-consent` 记录 `{ kind: 'grant', payload: { v: 1, httpsOrigin } }`。没有授权时，原生管理返回 `activationRequired`；仅由 Main 拥有的启用对话框发出 `activate`、提交授权并挂载服务。启用不授予手机权限。授权变更或凭据提供方替换会退役伴随生命周期；挂载失败会被处置，不会根据缓存结果重新启用。现有身份和授权记录保持独立。

仅 main 的原生消费者调用 `describe()`、`createInvitation()`、`approveCandidate(candidateId, confirmFingerprint)`、`cancelInvitation()` 和 `revokeGrant(grantId)`。`describe()` 向 Main 提供 `available`、`connected`、公开 `pcId`、配对标签、邀请 id/过期时间及候选 id/指纹/空显示名称。Main 仅向渲染进程投影可用性、连接状态和配对数量；候选与授权标识符仅供私有原生管理使用。`createInvitation()` 仅向已认证 Desktop main 返回 `{ invitationId, expiresAt, pairingUrl }`。main 使用剪贴板能力复制 `pairingUrl`，不向渲染进程返回任何含秘密的值。main 验证所属主窗口顶层帧调用者，校验 IPC 参数，并将相关回复绑定于当前 Host 实例。不使用旧 PC 启动令牌。

批准要求准确的本地候选 id 和准确的小写 SHA-256 指纹。取消在等待排队管理操作前立即中止正在提交的候选。撤销立即中止所有受影响通道的授权信号，然后删除已存储行并等待拆除。凭证写入失败会拒绝撤销完成，但旧信号保持撤回。本地 UI 必须说明后续文本可以执行现有 PC 任务或工具权限，不能暗示手机具有工具批准能力。

除非授权包含 `sessionManagementV1: true`，旧手机及新配对手机均不允许聊天管理。Main 原生的**已配对手机**对话框列出创建、重命名、归档与置顶／取消置顶，显示完整手机指纹并默认选择取消。只有 Main 调用 `setSessionManagement({ kind: 'setSessionManagement', grantId, expectedGeneration, fingerprint, enabled })`；Host 在凭据更新锁内重新核对当前授权 ID、代次和指纹，并撤回受影响通道。渲染进程没有批准 API。

模型选择和工具详情分别要求独立的 `modelSelectionV1: true` 与 `toolDetailsV1: true` 授权。原生 `setModelSelection` 和 `setToolDetails` 命令与聊天管理使用相同的授权 ID、预期代次、完整指纹和显式启用标志；渲染进程不能发出这些命令。每项决定均在凭据提交前退役受影响通道，撤回提交失败时也如此。

模型选项仅属于当前通道且保持不透明；提供方路由与凭据留在电脑上。仅供 Host 调用的 Session Controller 操作使用现有准入队列，选择一个已运行、普通且空闲的 Agent，采用所选模型的默认推理强度，并只刷新该 Session。工具摘要使用不可变观测或订阅拥有的有界精简调用缓存；准确调用引用与允许列表限制导出的元数据。首次订阅建立期间缺少调用时，可能先显示固定状态，直到重新读取历史后解析成功。

除非授权含有 `sessionActivationV1: true`，会话激活独立默认拒绝；v1–v4 授权中没有此字段，因此均拒绝访问。Main 原生**已配对手机**对话框显示完整指纹并提供**启用打开聊天**；只有 Main 可使用当前授权 ID、代次、完整指纹及明确的启用值调用 `setSessionActivation`。Host 在提交变更前退役该手机通道，其他权限保持不变。`getSessionActivation` 报告当前授权状态，只有显式的 `openSession` 请求会进入激活流程。列出会话、读取历史及观察进度都不会激活冷态 Agent。Host 调用 `sessionController.activateExistingAgent()`，打开已有且符合条件的普通 Session，不改变 Desktop 导航，也不提交文本；缺失、已归档、子智能体或不可用的 Session 会在准入前被拒绝。冷态激活使用电脑的常规 Agent 初始化和目标刷新。API 准入后，即使手机取消等待，初始化和刷新仍由 API 负责；手机可能收到 `unknown`，不会排入消息或新任务。

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

应用请求／结果使用共享[应用类型](../../util/companion-protocol/src/application-types.ts)与解析器／编码器，不使用操作员 RPC。封闭操作包含 `listSessions`、`readHistory`、`watchProgress`、`submitText`、`cancelRead`、`getSessionActivation`，以及单独授权的 `openSession`、`listManagementWorkspaces`、`createSession`、`renameSession`、`archiveSession` 和 `setSessionPinned`。独立的模型权限允许 `listSessionModels` 和 `selectSessionModel`；回复只包含不透明选项，不包含提供方路由标识。请求不允许通用 RPC 或电脑路径。单独授权的工具结果文本可以包含工作区相对标签，但不包含原始参数或提供方秘密。不提供删除命令或回执端点。手机提交 ID 在映射至现有 Session 请求 ID 前，以已认证授权及 Session 建立命名空间。完整 UTF-8 请求／结果／协议大小、发送排队字节、通道尝试、候选、授权、订阅与待处理操作均由显式配置限制。

[管理执行](src/session-management.ts)在调用现有电脑负责人前重新检查当前权限。创建使用手机已知的 `mobile-${operationId}` 标识，通过 `SessionController.create({ newSessionId, workspaceId })` 采用电脑默认预设且不添加人工文本；不会创建另一个控制器。`managed` 的 `outcome: 'applied'` 在负责人提交后返回，创建／重命名还须等待目标 Session 刷新。部分生效或刷新失败返回 `unknown`，不表示回滚或持久重放回执。归档拒绝繁忙 Session 且不调用 StopActivity，保留历史并移除电脑全局置顶。置顶／取消置顶写入电脑全局注册表元数据；导航仍是只读投影。

## 凭证存储

现有凭证键准确为 `companion-host/identity`，记录封装为 `{ kind: 'grant', payload }`。当前负载成员集合为 `{ v: 5, httpsOrigin, pcId, identityPublicKey, identityPkcs8, grants }`。合法的 v1–v4 记录加载时不重写；下一次合法身份或授权写入会保存为 v5，并保留密钥、未受影响的授权及代次。旧 Host 拒绝 v5：请使用匹配 Host，不要重置身份或降级记录。`identityPkcs8` 是 P-256 私钥 PKCS#8 DER 的规范无填充 base64url；`identityPublicKey` 是公开 SPKI DER 的规范 base64url。每个授权为 `{ grantId, generation, phoneIdentityKey, displayName, pairedAt }`，可独立包含 `sessionManagementV1: true`、`modelSelectionV1: true`、`toolDetailsV1: true` 和 `sessionActivationV1: true`；缺失时分别拒绝相应权限。v1 均不允许，v2 允许管理，v3 增加模型选择，v4 增加工具详情，v5 开始允许会话激活标志。`pairedAt` 为整数 Unix 毫秒，`displayName` 当前为空。此负载是私有数据，不得跨越公开 IPC 或渲染进程桥接。

[记录](src/records.ts)拒绝额外成员、版本或密钥或 id 或曲线或来源不匹配、超大记录、无效代际和重复手机密钥或授权 id。仅首次启动缺失允许生成身份。运行中记录删除、损坏或身份替换绝不静默重新生成；功能撤回并要求本地处理。端点变更要求本地重置与重新配对。重置是本地维护操作：在删除旧身份记录前先退役旧 Host 并撤回全部手机权限，再以新来源启动。复制凭证会克隆身份，包括本地锁无法保护的不同 home。

写入使用 `CredentialProvider.modifyRecord`，其本地实现持现有跨进程文件锁重新读取。不引入新数据库。任何记录更新事件都在异步重新加载前同步中止已注册通道信号。唯一正在提交的候选在自身存储提交期间没有应用权限，必须在 welcome 前重新读取当前记录；赋予授权后，每次记录变更也中止它。Credentials-local 在底层来源故障后保留最后有效读取缓存，但永久中止 `sourceFailureSignal` 并发出无负载的 `credentials/source-failed`；伴随功能检查初始健康状态，并在该事件中同步撤回权限。其原子写入器还缺少 fsync 与 Windows ACL 验证；不得宣称更强的持久性或权限保证。

## 父任务集成要求

- 将新包及共享协议加入根依赖解析、源码 `paths`、host/test 编译器聚合和构建或打包发现；仅由父任务授权安装依赖。包内引用与依赖分类见[清单](package.json)和[编译器配置](tsconfig.json)。
- 提供 `ws` 8.21.0 及声明的类型包、用于 Windows 句柄的 `koffi` 3.1.1，以及用于 POSIX `flock` 的工作区原生系统包。协议、品牌和配置辅助函数为运行时依赖；现有 Cordis 能力负责人为 peer 依赖，并有开发依赖对应项。测试源码审查后必须核对测试组合依赖。
- 仅在桌面拥有的 Host 中挂载，提供每个已验证预算和真实部署来源，使旧公开 PC 或操作员访问不进入伴随功能，并接入原生控制、私有剪贴板 IPC、本地化公开状态和警告。
- 使用仅供 Host 调用的 `SessionController.admitPrompt(request, admissionCheck)` 方法。其回调在异步解析后及紧邻收件箱插入前同步检查。回调必须检查可撤销通道信号与当前授权，并使用 `RemoteError('gateway/cancelled', ...)` 拒绝；只在 await 前读取一次并不足够。
- Android 必须实现此准确链接、中继封装、共享域隔离密码学、密钥确认、当前授权重连及封闭应用操作或结果集合。仅在共享协议中添加签名显示名称元数据或本地 PC 操作状态，绝不能在这里复制未声明的模式。
- 验证原生 Windows ACL 行为、锁失效或重复所有权、慢速发送拆除、重放或错误 UTF-8 拒绝、授权删除或代际竞争、不激活的冷历史读取、完整字节预算及送达未知处理。补充组装后的转录和 Desktop/Android 端到端证据。本次交付不运行上述操作。
