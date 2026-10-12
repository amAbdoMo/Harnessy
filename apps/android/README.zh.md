---
description: "原生前台 Android 伴侣组装、配对与送达安全，以及仅源码验证的限制。"
---

# Harnessy Android 伴侣

[English](<README.md>) | 中文

## 概述

原生 Java 伴侣源码组装了邀请配对、已有会话浏览、获准的纯文本历史与进度，以及向正在运行的电脑明确排队追加文本消息。智能体和会话存储仍由电脑持有。本次交接仅提供源码：不提供 APK，不声称编译成功、测试通过、设备运行或在线连接可用。

## 目录

- [应用组装](#application-assembly)
- [配对与存储](#pairing-and-storage)
- [读取与送达](#reads-and-delivery)
- [限制与验证](#limits-and-verification)
- [开发备注](#dev-note)

<a id="application-assembly"></a>
## 应用组装

[MainActivity](<app/src/main/java/io/harnessy/companion/MainActivity.java>) 是 [manifest](<app/src/main/AndroidManifest.xml>) 声明的导出原生启动组件和单任务邀请入口。它在主线程渲染 [CompanionView](<app/src/main/java/io/harnessy/companion/presentation/CompanionView.java>) 或 [PairingView](<app/src/main/java/io/harnessy/companion/presentation/PairingView.java>)，请求系统栏与键盘边距，并负责原生忘记配对／检查确认框。保留英中资源、浅色深色设计变量、原生无障碍控件与已有宽屏布局，不使用 WebView 或远程 JavaScript。

[CompanionController](<app/src/main/java/io/harnessy/companion/CompanionController.java>) 持有一个前台代次和当前连接尝试。`onStart` 加载并重新验证已存元数据，然后自动连接；`onStop` 立即使代次失效，取消控制器期限、重连及订阅，关闭传输并丢弃邀请。旧回调不能发布状态或发送消息。新尝试等待旧传输的 `quiescence()`。配置重建仅保留控制器有界内存中的草稿与选择，不保留网络活动；进程重建不恢复任务文本或草稿。不承诺后台服务、离线队列、推送通知或云端账户。

[CompanionApplication](<app/src/main/java/io/harnessy/companion/CompanionApplication.java>) 仅共享一个有界串行 IO 适配器。[AndroidCompanionPlatform](<app/src/main/java/io/harnessy/companion/AndroidCompanionPlatform.java>) 在 UI 线程外访问偏好设置与 keystore，通过同一所有者串行签名，并跨 Activity 实例等待传输终止。[CompanionPlatform](<app/src/main/java/io/harnessy/companion/CompanionPlatform.java>) 仅为控制器回归夹具暴露外部平台操作。

每次重连使用已存手机别名、固定的规范 HTTPS 源及电脑公钥，以及经认证的授权代次，构造新的 [PhoneTransport](<app/src/main/java/io/harnessy/companion/transport/PhoneTransport.java>)。协议 nonce、临时 ECDH 密钥、通道 ID 和计数器均重新生成。传输本身从不重连；控制器在前台按配置的最小间隔持续重试，没有有限的总尝试次数。密钥丢失或存储无效时停止自动尝试并要求明确修复。在线仅表示双方已确认加密密钥，不表示收件箱准入或任务完成。

<a id="pairing-and-storage"></a>
## 配对与存储

打开链接仅导入，不会自动配对。Activity 仅接受 `harnessy` scheme 与 `pair` host，导入后立即清除传入 Intent 的 data、extras 和 ClipData，且不导航任何 URL。[Invitation.parse](<app/src/main/java/io/harnessy/companion/protocol/Invitation.java>) 要求准确规范的 `harnessy://pair#` 文本、版本／字段／密钥／源／电脑 ID 验证，以及未过期的邀请。取消、过期、转入后台或认证成功时丢弃邀请、链接和秘密引用；Java 与提供方缓冲区清除仍是尽力而为。

明确执行配对后，通过 [PhoneIdentity.createForPairing](<app/src/main/java/io/harnessy/companion/identity/PhoneIdentity.java>) 创建独立的注册别名。配对视图显示手机公开 SPKI DER 的完整 64 个小写字符 SHA-256 指纹，用于与电脑对话框比较。签名器调用 `signTranscript(alias, bytes)`，从不导出私钥。同一电脑已有配对时必须先明确忘记它再注册。丢失或无效的配对密钥绝不会被静默替换。

仅认证后的 `onConfirmed` 授权 ID／代次、固定电脑公钥／源／派生电脑 ID 及手机别名进入 [PairingStore](<app/src/main/java/io/harnessy/companion/pairing/PairingStore.java>)。协议不含电脑名称，因此展示名称是通用的本地化标签。使用前根据 [Protocol](<app/src/main/java/io/harnessy/companion/protocol/Protocol.java>) 重新验证已存元数据。UI 展示第一项已存电脑；虽然存储保留最多 32 项记录，但尚无已存电脑选择器。

[OperationStore](<app/src/main/java/io/harnessy/companion/pairing/OperationStore.java>) 最多保留 32 项最小送达阻止记录，以及 32 项公开电脑 ID／别名修复标记。注册持久化或本地忘记操作前先写入修复标记。SharedPreferences 的 `commit()` 失败可能改变内存而无法确认磁盘持久性：控制器继续阻止操作并保留别名，不声称回滚，也不删除可能已被引用的密钥。即使已确定的配对元数据不存在，修复标记仍可标识别名。损坏或未知版本文档不会自动重置。已确认存储结算在前台退役后仍保留，并在后续存储修改前与新元数据协调；清除送达不确定性不会清除独立的配对修复阻止状态。

忘记配对是本地操作，不是电脑撤权。Activity 先警告，再阻止并停止所有者，提交元数据移除，仅在该提交成功后删除准确的手机别名，最后清除修复标记。元数据提交失败时保留别名与阻止记录。偏好设置与 keystore 操作不是跨存储原子事务。送达未知记录在忘记配对后仍保留；撤权或忘记配对不会删除电脑已接收的任务。重置损坏的应用数据前请检查原会话。

<a id="reads-and-delivery"></a>
## 读取与送达

[应用编解码器](<app/src/main/java/io/harnessy/companion/protocol/ApplicationCodec.java>) 仅消费 `listSessions`、`readHistory`、`watchProgress`、`cancelRead` 和 `submitText` 的经验证不可变 DTO。每个请求使用新关联 ID。待读取数量与期限独立于修改请求并受限。重连仅重建读取／订阅，保留同会话文本并重新获取状态。watch 确认先建立实时订阅，再读取历史基线；续订先取消旧订阅，再重新执行此流程。基线与有界实时窗口合并；watch 或 cancel 结果未知时关闭该尝试，防止远端订阅累积。

独立原生加载更多控件将不透明的列表／历史游标原样传回签发它的操作。进度游标不会成为历史游标。进度要求准确的订阅 ID、选定会话及当前前台代次／尝试。行 ID 与序号在有界且按序保留的文本窗口中去重。纯文本 `TextView` 输出不包含可点击链接、脚本或原始工具参数。排队／运行仅展示忙碌状态，仍允许排队追加；已关闭会话禁止编辑器发送。不从错误码推断协议不支持的审批状态。

明确发送要求连接已确认、已选择现存且未关闭的会话，并且没有待确认修改或送达未知记录。控制器固定会话、文本、请求与提交 ID，在传输准入前提交最小 `{pcId, sessionId, submissionId}` 阻止记录，不持久化任务文本或重发内容。`ADMITTED_MAY_WRITE` 在准确匹配且 `admission=inMemoryInbox` 的 `submitted` 结果到达前仍不确定；该结果仅确认电脑的易失内存收件箱，不表示持久性或任务完成。仅在移除阻止记录的提交已确认且草稿未改变时清空草稿。

可能已准入后的断连、超时或前台停止保留 `DELIVERY_UNKNOWN`；重连或进程重启绝不重发。发送前阻止记录提交失败会禁止发送；移除记录提交失败时，即使偏好设置内存已改变，编辑器仍被阻止。原会话与提交 ID 保持可见。本地化的检查／丢弃操作要求用户检查原会话后通过原生确认框，仅提交移除警告并允许新的明确发送，不会重发、取消或删除旧任务。

<a id="limits-and-verification"></a>
## 限制与验证

[XML 预算](<app/src/main/res/values/limits.xml>) 明确提供 [ControllerLimits](<app/src/main/java/io/harnessy/companion/ControllerLimits.java>) 与 [TransportLimits](<app/src/main/java/io/harnessy/companion/transport/TransportLimits.java>)：最短重连间隔 5 秒、读取期限 10 秒、修改 ACK 期限 15 秒、只读心跳 20 秒、续订 60 秒、8 个待读取、每页 64 行、256 个会话，以及 256 行／256 KiB 保留文本。心跳是有界 `listSessions(limit=1)`，不是新协议操作；当前 broker 拒绝 ping／pong 且只将应用帧计为活动，因此禁用原生 ping。OkHttp 在监听器保留检查前分配完整传入文本；这些预算不声称限制组装前内存。

[Gradle 声明](<app/build.gradle>) 保持 AGP 8.7.3、compile／target SDK 35、最低 SDK 26、Java 8 源码、JDK 17／Gradle 8.9 前提及 OkHttp 4.12.0。[Wrapper 属性](<gradle/wrapper/gradle-wrapper.properties>) 仅固定发行包；真实 wrapper 脚本／JAR／校验和、SDK／工具链配置、签名及部署属于整合所有者。Manifest 禁用明文传输和备份／设备迁移，不提供凭据、邀请秘密、私钥、生成的二进制文件或新依赖。

[ProtocolRegression](<app/src/test/java/io/harnessy/companion/protocol/ProtocolRegression.java>) 位于测试源码，不属于 APK 的生产源码。[ControllerRegression](<app/src/test/java/io/harnessy/companion/ControllerRegression.java>) 添加丢失 ACK／旧代次、等待完全终止且限速的重连、配对密钥丢失、偏好设置失败阻止、不透明分页与关联、运行会话发送、草稿 ACK 语义、重启警告和注册／忘记失败的源码场景。仅模拟外部时钟、网络、keystore、偏好设置与执行器操作；控制器、解析器及模型保持真实。这些独立 `main` 回归入口不会被 JUnit 自动发现，需要配置 JVM 运行器；它们未在此编译或执行。

运行验收要求 Android 编译、lint、manifest 合并、Node 互操作与 broker／电脑连接、平台 API 26／35 及真实 keystore／偏好设置失败行为、前台／配置／进程重建、英中／浅深色／手机平板／横屏／大字体／TalkBack／键盘展示、备份排除，以及针对性单元、设备与 UI 证据。源码审查与 TypeScript／文档检查不证明这些结果；APK 构建、签名、部署和设备验证仍待执行。

<a id="dev-note"></a>
## 开发备注

无。
