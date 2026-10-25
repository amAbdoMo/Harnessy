---
description: "原生 Kotlin／Compose Android 聊天、具备生命周期感知的加密电脑访问、配对与送达安全，以及设备验证限制。"
---

# Harnessy Android 伴侣

[English](<README.md>) | 中文

## 概述

原生 Kotlin／Jetpack Compose 应用提供配对、已有会话聊天、明确打开符合条件的冷态聊天、获准的文本历史与进度，以及向正在运行的电脑排队追加消息。Material 3 界面使用具备生命周期感知的 ViewModel／StateFlow 状态、Hilt 所有权、Compose 导航和 DataStore 外观偏好。Java 协议／存储核心通过 Kotlin 互操作保留；单独获得 PC 许可后可使用四种聊天管理操作。智能体、特权工具、服务商凭据和会话存储仍由电脑持有。构建、JVM、设备、配对与后台送达证据相互独立；源码本身不能证明其中任何一项。

## 目录

- [应用组装](#application-assembly)
- [Workspace 导航](#workspace-navigation)
- [模型选择](#model-selection)
- [会话激活](#session-activation)
- [配对与存储](#pairing-and-storage)
- [读取与送达](#reads-and-delivery)
- [限制与验证](#limits-and-verification)
- [已知限制](#known-limitations)
- [开发备注](#dev-note)

<a id="application-assembly"></a>
## 应用组装

[NativeActivity](<app/src/main/java/io/harnessy/companion/nativeapp/NativeActivity.kt>) 承载 [Material 3 导航与界面](<app/src/main/java/io/harnessy/companion/nativeapp/NativeCompanionApp.kt>)，由 [manifest](<app/src/main/AndroidManifest.xml>) 声明。Activity 作用域的 [ViewModel](<app/src/main/java/io/harnessy/companion/nativeapp/CompanionViewModel.kt>) 通过主线程 [repository 适配器](<app/src/main/java/io/harnessy/companion/nativeapp/CompanionRepository.kt>) 暴露不可变 StateFlow 快照。

手机通过可搜索的抽屉筛选已加载的对话；宽屏布局可在聊天旁显示导航。原生侧栏标题将 Harnessy 品牌与调试版启动器名称分开，在分割线上方提供圆形搜索与关闭控件；紧凑侧栏仅显示品牌图标，不显示字标。平直色带区分选中、按下、指针悬停和键盘焦点状态。手机和宽屏均可隐藏并重新打开导航。

[工作首页](<app/src/main/java/io/harnessy/companion/nativeapp/NativeWorkLanding.kt>)以平直、可纵向滚动的行展示真实且已加载的电脑对话，而不是新任务建议；送达与错误提示优先于最近对话。适配键盘边距的[自适应编辑器](<app/src/main/java/io/harnessy/companion/nativeapp/NativeComposer.kt>)使用适配主题的无边框卡片与仅对当前 Session 生效的模型选择器，省略冗余的就绪／未选择提示，要求选定对话后才能编辑，并将已关闭对话保持为只读。键盘使窗口高度受限时，编辑器使用紧凑行并保留草稿、焦点和顶部控件；键盘收起后恢复完整提示。忘记配对与检查送达状态均要求明确确认。英中资源与中性的浅色／深色主题均保持原生实现，不使用 WebView 或远程 JavaScript。

[设置](<app/src/main/java/io/harnessy/companion/nativeapp/NativeSettingsScreen.kt>)提供紧凑且无障碍的主题选项，展示电脑报告的聊天管理权限，并在权限未获准时提供电脑端设置指引。打开导航会清除草稿焦点并收起其键盘；侧栏搜索会预留键盘空间。导航控件与对话位于同一滚动列表中，标题和搜索框保持固定。键盘收起时，系统返回操作会关闭手机抽屉而不离开聊天。

[对话记录](<app/src/main/java/io/harnessy/companion/nativeapp/NativeTranscriptModel.kt>)将连续的工具名称行折叠为本地[活动展开区域](<app/src/main/java/io/harnessy/companion/nativeapp/NativeToolActivity.kt>)，与助手正文分开。提示始终显示在展开区域之外，包括轮次失败提示；单独的工具名称没有空的展开控件。精确匹配的已知工具名称使用现有电脑端图标类型；未知名称使用通用图标。展开后的名称在有界滚动区域中保持原始顺序和原文；切换展开状态时会将分组滚动到可见区域。向同一分组追加内容时保留查看状态，但切换对话、重建 Activity 或移除该组首个保留行时会重置；查看操作不会调用电脑端工具。这些分组仅表示相邻名称，不会重建电脑端轮次或调用与结果的对应关系；协议不提供工具输入、结果正文、各工具状态或耗时。工具活动目前通过实时进度传入，不包含在历史文本分页中。

[CompanionController](<app/src/main/java/io/harnessy/companion/CompanionController.java>) 持有一个前台代次和当前连接尝试。`onStart` 加载并重新验证已存元数据，然后自动连接；`onStop` 立即使代次失效，取消控制器期限、重连及订阅，关闭传输并丢弃邀请。旧回调不能发布状态或发送消息。新尝试等待旧传输的 `quiescence()`。配置重建会保留控制器中有界的 RAM 草稿与选择，但不会保留网络活动。草稿按电脑与聊天键控；进程重建不会恢复任务文本或草稿。不承诺后台服务、离线队列、推送通知或云端账户。

[HarnessyApplication](<app/src/main/java/io/harnessy/companion/HarnessyApplication.kt>) 与 [Hilt 模块](<app/src/main/java/io/harnessy/companion/nativeapp/CompanionModules.kt>) 共享一个有界串行 [AndroidCompanionPlatform](<app/src/main/java/io/harnessy/companion/AndroidCompanionPlatform.java>) 所有者。偏好设置／keystore 操作与签名在 UI 线程外运行，并跨 Activity 实例等待传输终止。控制器使用 ViewModel 作用域，不是应用单例。[NativePreferences](<app/src/main/java/io/harnessy/companion/nativeapp/NativePreferences.kt>) 仅通过 DataStore 存储普通外观设置；密钥别名、配对元数据、修复标记和送达阻止记录保留原有存储语义。不引入 Room 数据库或手机持有的会话缓存。

每次重连使用已存手机别名、固定的规范 HTTPS 源及电脑公钥，以及经认证的授权代次，构造新的 [PhoneTransport](<app/src/main/java/io/harnessy/companion/transport/PhoneTransport.java>)。协议 nonce、临时 ECDH 密钥、通道 ID 和计数器均重新生成。传输本身从不重连；控制器在前台按配置的最小间隔持续重试，没有有限的总尝试次数。密钥丢失或存储无效时停止自动尝试并要求明确修复。在线仅表示双方已确认加密密钥，不表示收件箱准入或任务完成。

<a id="workspace-navigation"></a>
## Workspace 导航

[原生会话导航](<app/src/main/java/io/harnessy/companion/nativeapp/NativeSessionNavigation.kt>)按 PC 声明的 Workspace 身份与顺序分组已加载对话。

文件夹展开／收起选择按电脑和 Workspace 身份保存在手机 DataStore 中，跨导航和应用重启保留；新文件夹默认收起。搜索会暂时展开匹配文件夹，不覆盖保存的选择。这些手机本地选择不镜像或修改 Desktop 侧栏。未分配对话没有文件夹标题。

导航视图镜像 PC 全局置顶，在每组内优先按置顶顺序排列，其后按最近时间排列。单独获得 PC 批准的操作可以修改置顶。每组初始最多显示五个对话；若置顶超过五个，则显示全部置顶对话；“显示更多”展开其余已加载行。标题／Workspace 名称搜索与“未关闭”筛选仅作用于已加载行，不是 PC 全局搜索。文件夹与置顶图标复用 Desktop 几何轮廓。

相对时间取 PC 创建时间与最近一次已持久化人工提示时间的较大值，不使用助手完成时间。元数据缺失时，绝不推断文件夹、置顶或时间。进度状态更新保留此前接收的导航元数据。导航不暴露文件路径，也不提供空 Workspace 清单。**新聊天**使用独立受权限控制的真实已注册 Workspace 选择器，包括已注册的空分组，并以 PC 默认预设创建空 Session，不提交人工文本，不提供模型／提供方控件。PC 授权后，行菜单提供仅驻留内存的输入式重命名、归档及置顶／取消置顶；永久删除已延期，不提供协议命令或 UI。归档拒绝忙碌聊天、保留历史并移除其置顶，不提供停止快捷操作。重命名和提交文本要求聊天已打开。新聊天和归档任一聊天均不能丢弃非空草稿。管理手势绑定前台代次、PC 和目标；延迟的创建确认不能替换更新的选择或草稿。参见[权限与更新顺序](<../../docs/upgrade-guide/v0.1.15/companion-chat-management/guide.zh.md>)。

普通列表请求 `view: 'navigation'`；心跳列表仍使用旧请求。**使用此手机 API 前必须先更新 PC。** 旧 PC 的精确字段解析器会拒绝视图请求并关闭通道；不提供宽松兼容回退。省略视图的旧手机仍可从更新后的 PC 接收旧格式行。请遵循[升级指南](<../../docs/upgrade-guide/v0.1.15/companion-navigation/guide.zh.md>)；修改源码不会更新运行中的 PC，也不代表设备验收通过。

<a id="model-selection"></a>
## 模型选择

Gradle 属性 `companion.pcModelSelection` 默认为 `true`。启用后，[模型选择器](<app/src/main/java/io/harnessy/companion/nativeapp/NativeModelSelector.kt>)在打开时读取一页有界电脑端目录，绝不虚构模型或导出提供方路由。使用前先部署匹配的电脑端支持；读取或选择仍需单独的逐手机模型许可。选择绑定已渲染的前台代次、电脑、聊天、版本标识和不透明选项，只接受在线且空闲的聊天，并保留草稿。最小 `selectSessionModel` 阻止记录先于任何可能的传输写入；只有关联匹配的结果及已确认移除记录才更新显示选择。结果未知时阻止进一步更改／发送，直到明确检查；绝不自动重放。参见[更新顺序及降级限制](<../../docs/upgrade-guide/v0.1.17/companion-model-and-tool-consent/guide.zh.md>)。

若 Android 界面开发所连接的电脑不支持模型操作，可显式设置 `-Pcompanion.pcModelSelection=false`；模型控件会说明缺少支持，且不查询或选择模型。只接受 `true` 和 `false`。此退出选项不授予电脑端权限，也不重置手机存储。

<a id="session-activation"></a>
## 会话激活

符合条件的已有冷态普通聊天可通过[打开聊天](<app/src/main/java/io/harnessy/companion/nativeapp/NativeSessionActivation.kt>)在电脑运行时显式打开，无需 Desktop 标签页。列出会话或读取历史都不会激活电脑端 Agent。打开操作要求电脑为该手机单独授权，并在**已配对手机**中选择**启用打开聊天**；配对、聊天管理、模型选择及工具详情授权均不包含此权限。此操作通过电脑常规 Agent 初始化恢复已有聊天，并仅刷新目标 Session；初始化可能迁移或修复历史、运行 SessionStart 插件，即使失败也可能留下这些影响。操作不会发送文本或新任务，也不改变其他聊天或全局模型默认值。准入后若回复丢失，会留下不确定性阻止记录；手机不会自动重试。参见[会话激活升级指南](<../../docs/upgrade-guide/v0.1.17/companion-session-activation/guide.zh.md>)。

<a id="pairing-and-storage"></a>
## 配对与存储

打开链接仅导入，不会自动配对。无历史／无界面的 [InvitationActivity](<app/src/main/java/io/harnessy/companion/nativeapp/InvitationActivity.kt>) 仅接受 `harnessy` scheme 与 `pair` host，清除传入 Intent 的 data、extras 和 ClipData，并通过一次性内存收件箱传递有界文本。保留的主任务接收不含邀请的干净 Intent；恢复不是新的邀请送达。配对界面禁止屏幕捕获，API 33 及以上禁用最近任务截图，较旧设备使用安全窗口保护。不导航任何 URL。[Invitation.parse](<app/src/main/java/io/harnessy/companion/protocol/Invitation.java>) 要求准确规范的 `harnessy://pair#` 文本、版本／字段／密钥／源／电脑 ID 验证，以及未过期的邀请。取消、过期、转入后台或认证成功时丢弃邀请、链接和秘密引用；Java 与提供方缓冲区清除仍是尽力而为。

**设置 → 电脑连接 → 关联电脑**会打开配对表单，不会忘记已有电脑。明确执行配对后，通过 [PhoneIdentity.createForPairing](<app/src/main/java/io/harnessy/companion/identity/PhoneIdentity.java>) 创建独立的注册别名。配对视图显示手机公开 SPKI DER 的完整 64 个小写字符 SHA-256 指纹，用于与电脑对话框比较。签名器调用 `signTranscript(alias, bytes)`，从不导出私钥。同一电脑已有配对时必须先明确忘记它再注册。丢失或无效的配对密钥绝不会被静默替换。

仅认证后的 `onConfirmed` 授权 ID／代次、固定电脑公钥／源／派生电脑 ID 及手机别名进入 [PairingStore](<app/src/main/java/io/harnessy/companion/pairing/PairingStore.java>)。协议不含电脑名称，因此展示名称是通用的本地化标签。使用前根据 [Protocol](<app/src/main/java/io/harnessy/companion/protocol/Protocol.java>) 重新验证已存元数据。UI 使用第一项已存电脑。保存显式注册的电脑时会将其置于首位，因此返回前台或恢复进程后仍使用该电脑，不移除其他配对或密钥别名。存储最多保留 32 项记录；UI 不提供已存电脑选择器。

[OperationStore](<app/src/main/java/io/harnessy/companion/pairing/OperationStore.java>) 最多保留 32 项最小送达阻止记录，以及 32 项公开电脑 ID／别名修复标记。现有单个偏好文档读取有效 v1/v2 时不会重写；下一次合法写入会输出 v3，并保留阻止记录与修复标记，不改变配对密钥。v3 阻止记录按电脑 ID 和 Session ID 键控，仅含 `{kind, pcId, sessionId, operationId}`，不含标题、Workspace ID、文本或重试载荷。移除时先比较准确的预期阻止记录。注册持久化或本地忘记操作前先写入修复标记。SharedPreferences 的 `commit()` 失败可能改变内存而无法确认磁盘持久性：控制器继续阻止操作并保留别名，不声称回滚，也不删除可能已被引用的密钥。即使已确定的配对元数据不存在，修复标记仍可标识别名。损坏或未知版本文档不会自动重置。已确认存储结算在前台退役后仍保留，并在后续存储修改前与新元数据协调；清除送达不确定性不会清除独立的配对修复阻止状态。

忘记配对是本地操作，不是电脑撤权。Activity 先警告，再阻止并停止所有者，提交元数据移除，仅在该提交成功后删除准确的手机别名，最后清除修复标记。元数据提交失败时保留别名与阻止记录。偏好设置与 keystore 操作不是跨存储原子事务。送达未知记录在忘记配对后仍保留；撤权或忘记配对不会删除电脑已接收的任务。重置损坏的应用数据前请检查原会话。

<a id="reads-and-delivery"></a>
## 读取与送达

[应用编解码器](<app/src/main/java/io/harnessy/companion/protocol/ApplicationCodec.java>) 消费封闭的[读取、文本和管理操作集合](<../../packages/util/companion-protocol/README.zh.md#application-management-compatibility>)的经验证不可变 DTO，其中包括[显式会话激活](<../../packages/util/companion-protocol/README.zh.md#application-session-activation>)。每个请求使用新关联 ID。待读取数量与期限独立于修改请求并受限。重连仅重建读取／订阅，保留同会话文本并重新获取状态。未关闭会话先建立已确认的实时订阅，再读取历史基线；续订先取消旧订阅，再重新执行此流程。已关闭会话直接读取获准历史，不建立订阅；恢复后的已关闭聊天必须先取得新的 watch 确认，才能进行实时读取。管理确认绝不提供 watch 权限。关闭进度仅终止对应 watch，不影响独立的历史读取。基线与有界实时窗口合并；watch 或 cancel 结果未知时关闭该尝试，防止远端订阅累积。关联匹配的恢复仅能清除读取失败提示，不会清除存储、修复、发送或送达警告。

独立原生加载更多控件将不透明的列表／历史游标原样传回签发它的操作。进度游标不会成为历史游标。进度要求准确的订阅 ID、选定会话及当前前台代次／尝试。行 ID 与序号在有界且按序保留的文本窗口中去重。[原生 CommonMark 投影](<app/src/main/java/io/harnessy/companion/nativeapp/markdown/NativeMarkdownFormatter.kt>) 在 UI 线程外运行，限制 AST 深度／节点和完整输出，并在遇到不支持的内容时回退为原始获准文本。引用、分割线和引用定义保留周围排版。HTML 保持原始文本；链接／图片转为文字，不导航或发起网络加载。不执行脚本或原始工具参数。Kotlin 适配器将发送绑定到已渲染的前台代次、电脑、会话和草稿；格式错误或超过预算的 UTF-8 输入被拒绝，不替换此前有效输入。排队／运行仅展示忙碌状态，仍允许排队追加；已关闭会话禁止编辑器发送。不从错误码推断协议不支持的审批状态。

明确发送要求连接已确认、已选择现存且未关闭的会话，并且没有待确认修改或送达未知记录。控制器固定会话、文本、请求与提交 ID，在任何可能的传输写入前提交最小 v3 `submitText` 阻止记录，不持久化任务文本或重发内容。`ADMITTED_MAY_WRITE` 在准确匹配且 `admission=inMemoryInbox` 的 `submitted` 结果到达前仍不确定；该结果仅确认电脑的易失内存收件箱，不表示持久性或任务完成。仅在移除阻止记录的提交已确认且草稿未改变时清空草稿。

可能已准入后的断连、超时或前台停止保留 `DELIVERY_UNKNOWN`；重连或进程重启绝不重发。发送前阻止记录提交失败会禁止发送；移除记录提交失败时，即使偏好设置内存已改变，编辑器仍被阻止。原会话与提交 ID 保持可见。本地化的检查／丢弃操作要求用户检查原会话后通过原生确认框，仅提交移除警告并允许新的明确发送，不会重发、取消或删除旧任务。

管理写入沿用相同的“可能写入前先提交”阻止机制，绝不自动重放。`managed` 完成遵循[PC 所有者的提交／刷盘策略](<../../packages/host/companion-host/INTEGRATION.md#actual-relay-and-endpoint-wire>)；部分生效或未知结果要求明确检查已知 PC／Session／操作，不能显示为**任务已排队**。阻止记录提交失败时禁止写入；比较并清除失败时继续阻止操作。检查仅移除准确的不确定性警告，不撤销 PC 操作。

<a id="limits-and-verification"></a>
## 限制与验证

[XML 预算](<app/src/main/res/values/limits.xml>) 明确提供 [ControllerLimits](<app/src/main/java/io/harnessy/companion/ControllerLimits.java>) 与 [TransportLimits](<app/src/main/java/io/harnessy/companion/transport/TransportLimits.java>)：最短重连间隔 5 秒、读取期限 10 秒、修改 ACK 期限 15 秒、只读心跳 20 秒、续订 60 秒、8 个待读取、每页 64 行、256 个会话，以及 256 行／256 KiB 保留文本。心跳是有界 `listSessions(limit=1)`，不是新协议操作；当前 broker 拒绝 ping／pong 且只将应用帧计为活动，因此禁用原生 ping。OkHttp 在监听器保留检查前分配完整传入文本；这些预算不声称限制组装前内存。

[Kotlin DSL 构建声明](<app/build.gradle.kts>) 定义仅 Android 的 Compose／Hilt／KSP 技术栈、JDK 17 字节码、compile／target SDK 37 和最低 SDK 26。真实 [Windows wrapper](<gradlew.bat>) 与 [wrapper 属性](<gradle/wrapper/gradle-wrapper.properties>) 使用发行方 SHA-256 固定 Gradle 9.6.0。配置 Java／SDK 路径后，通过该 wrapper 执行 `:app:assembleDebug`、`:app:testDebugUnitTest`、`:app:lintDebug` 和 `:app:assembleDebugAndroidTest`。调试应用 ID 以 `.debug` 结尾，与签名发行版分离。签名材料保留在源码管理之外。Manifest 禁用明文传输与备份／设备迁移。

验证源码：[Java 核心／JUnit 入口](<app/src/test/java/io/harnessy/companion/NativeCoreRegressionTest.kt>)、[repository 生命周期／输入](<app/src/test/java/io/harnessy/companion/nativeapp/CompanionRepositoryMigrationTest.kt>)、[已渲染发送绑定](<app/src/test/java/io/harnessy/companion/NativeSubmissionBindingTest.kt>)、[Markdown 投影](<app/src/test/java/io/harnessy/companion/nativeapp/markdown/NativeMarkdownFormatterTest.kt>)、[模型送达安全](<app/src/test/java/io/harnessy/companion/ModelSelectionControllerTest.kt>) 和 [Compose 设备检查](<app/src/androidTest/java/io/harnessy/companion/nativeapp/NativeChatMigrationTest.kt>)。源码覆盖与 instrumentation APK 编译均不等于设备执行证据。

优先使用实体 Android 设备进行 USB／无线 ADB、Android Studio／Logcat 和 Compose UI 检查；模拟器是可选项。仅调试版的 [Compose 预览](<app/src/debug/java/io/harnessy/companion/nativeapp/NativeChatPreviews.kt>) 不创建套接字或存储。实际验收要求检查 keystore／存储行为、前台／配置／进程恢复、邀请路由与捕获保护、英中／浅深色／手机平板／横屏／大字体／TalkBack／键盘行为、备份排除，以及加密电脑互操作。API 26–32 的安全窗口保护还会阻止截图／scrcpy；较新设备允许普通聊天截图，但不允许配对界面截图。APK 构建／签名成功不代表设备或连接验收通过。

<a id="known-limitations"></a>
## 已知限制

当前电脑协议不提供账号切换／自动切换、用量／累积重置、助手文本增量流、远程工具审批、附件或关闭应用后的推送。管理和模型选择在 PC 分别授权前均独立默认拒绝；设置说明电脑持有的能力，不虚构账号、模型或推送状态。账号更改需要单独获得 PC 批准的能力；服务商凭据不得离开电脑。后台通知需要已配置的推送基础设施和电脑持有的事件生产者，而不是常驻手机套接字。Markdown 支持原生排版／代码，不提供语法高亮；不支持的结构保留原始文本。

<a id="dev-note"></a>
## 开发备注

无。
