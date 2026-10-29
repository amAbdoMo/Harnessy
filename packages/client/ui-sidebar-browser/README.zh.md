---
description: "右侧 Sidebar 浏览器 tab：在 sandbox 中访问 HTTP(S) 页面，包括 loopback 服务。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-sidebar-browser

[English](README.md) | 中文

## 概述

在独立的右侧 Sidebar tab 中浏览 HTTP(S) 页面，包括 loopback 服务。Web 使用 iframe 和应用维护的 history；Desktop 使用 Electron `<webview>`、原生导航 history 和保活页面。Browser 使用单一页面区域和紧凑的导航、反馈工具栏。本包不会向被访问内容注入 Electron 或 Node 能力。

## 目录

- [使用本包](#use-this-package)
- [了解实现](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

Browser 在 Web profile 中默认禁用，在 Desktop 中默认启用。Web 用户可通过 profile patch 启用随附条目。可以从右侧 Sidebar guide 打开 **浏览器**并输入 HTTP(S) URL。Chat 的[链接偏好](../ui-chat/README.zh.md)选择**应用内侧边栏**时，HTTP(S) 链接会在此打开。不带 scheme 的主机名会补全为 HTTPS。公共目标与 loopback 目标使用相同的默认 sandbox。每次 guide 操作或委托到此的消息链接操作都会创建一个新的 Browser tab。

Desktop 浏览器标签页绑定到所属聊天，并保留 Chromium 登录存储。接管会停止 Agent 操作；恢复 Agent 会将控制权交回所属聊天。工具栏不再提供设备模式切换。Agent 浏览器操作和所有权见 [Desktop 包](../../../apps/desktop/README.zh.md)。

### 何时选择

当 Web 页面需要保留在当前 Session 旁时，选择 Browser。本地文件使用 [Document Preview](../ui-sidebar-documentpreview/README.zh.md)；站点拒绝 iframe 嵌入或需要本包不授予的浏览器 capability 时，使用明确的外部浏览器操作。

### 最小配置

本包没有插件配置字段。Web profile 通过其 profile patch 启用随附条目：

```yaml
- id: ui-sidebar-browser
  disabled: false
```

Client 插件可以调用 `ctx.sidebarRight.openTab('browser', { params: { url } })` 打开 tab。可选 URL 会在导航前接受与地址栏输入相同的校验。

命令 `browser.new` 在焦点停靠分栏打开独立浏览器页，替换开始页并保留已有内容页。从聊天区或浮动内容页触发时，使用活动停靠分栏。桌面默认键在 macOS 上为 Cmd+T，在 Windows 上为 Ctrl+T；Windows 和 macOS Web 使用[快捷键服务的平台默认值](../shortcuts/README.zh.md)；Linux Web 默认不绑定此命令。开始页按钮使用蓝色地球图标，并在按钮内显示有效快捷键，不额外弹出重复提示。

工具栏使用带无障碍标签的图标按钮进行导航、标签页控制和标注。标注网页会捕获当前视口，并在页面上显示选择、区域、绘制、擦除和撤销工具，以及行内备注输入框和添加到对话按钮，不会打开对话框。取消或 Escape 会丢弃标注。捕获会切换为人工控制，并保持该状态直到选择恢复 Agent。标注期间无法导航或恢复 Agent。添加到对话会将标注 PNG、页面地址与标题、所选元素信息加入当前聊天草稿，不会直接发送消息。普通 Desktop 标签页保留标题及地址检查点；保存账号的标签页保留配置的起始地址。保存的账号和加密登录信息通过工具栏菜单管理。

保存配置表单将不带协议的主机名补全为 HTTPS，并要求使用设置中已连接 MCP 服务器的准确名称。无效字段会在输入框旁显示修改提示并保留草稿；保存的起始地址不能包含凭据、查询参数或片段。Desktop 失败通过允许列表中的标识符选择本地化恢复提示；原始诊断和账号值不会进入配置通知。

-----

<a id="understand-the-implementation"></a>
## 了解实现

<details>
<summary>实现细节——点击展开</summary>

### 协议策略

地址解析器接受 HTTP 与 HTTPS，包括 loopback 目标。`file:` URL、脚本/data/blob 输入、内嵌凭据、DSH 应用自身 origin 和畸形地址会被拒绝。本地文件由 Document Preview 负责渲染。

### Iframe 载体

Web 默认使用 `sandbox="allow-scripts allow-forms allow-same-origin allow-popups allow-popups-to-escape-sandbox"`。frame 没有直接的下载或顶层导航 flag。popup 会脱离 sandbox；在 Web 中，逃逸的 popup 会保留 opener，并可以导航顶层应用。被访问的 origin 可以使用自身 Cookie 与 Web storage，但跨域目标无法读取 DSH DOM、storage 或 API 响应。iframe 不发送 referrer，也不添加包自有的 Permissions Policy，因此浏览器默认策略与用户授权生效。toolbar 可以为当前 tab occurrence 移除 sandbox；该选择不持久化。未受 sandbox 约束的页面可以按浏览器 activation 规则导航顶层应用，并使用下载、模态对话框和输入锁定。本包不代理或探测远程页面。

Web 记录 toolbar 提交和 typed tab 打开。导航状态机把每个受控 revision 的第一次 iframe load 视为已知，把后续 load 视为页面已经变化到不可读取 URL 的证据。进入 unknown 状态后，地址会显示标记，后退、前进和外部打开会禁用，刷新则返回最后一个受控 URL。body 重挂载时会重新加载应用最后已知的 URL，并且仅在尚无受控目标时使用可选初始 URL。不产生 iframe load 的 History API 与 fragment 变化仍不可见。iframe `error` event 会显示临时加载失败 notice，直到下一个受控加载，但不会改变 URL history。

### Controller

Desktop 向私有 [Browser 响应式集成](../ui-device-preview/README.zh.md)提供以纯类型声明共享的 `nativeBrowser` 页面服务。使用者负责页面销毁。普通页面可以在不导航的情况下应用固定 CSS 视口尺寸；已保存账号页面不提供视口操作。原生命令成功后的通知标识精确租约及已确认尺寸，释放操作则在实际等待 guest 结束前撤销关联。

每个 tab 的 `BrowserController` 负责地址校验、命令和显式恢复。`BrowserFrame` 提供与载体无关的导航状态；`IframeImpl` 使用 `BrowserNavigation`，`ElectronWebViewImpl` 仅为普通 tab 观察 Chromium history。`BrowserPresentation` 负责 DOM 的物理挂载。Session 所有的 `WebsiteRequestSession` 维护有界请求列表与精确 claim；每个已保存账户页面负责自身的准入、撤销和清理等待。销毁会同步停止请求列表观察，并在不等待原生清理完成的情况下撤下控件。它会等待准入和 guest 释放，包括迟到的获取结果；失败的清理仍可等待，并阻止复用。框架绑定的 Browser、profile 和 request hook 提供快照；组件只接收普通 callback，不接收 provider 或 observable 对象。

Desktop Main 管理 guest lease、标签页所有权、人工控制、账号存储和加密登录保险库。Preload 提供限定范围的人工控制，以及有界的标注捕获和选择。共享声明通过 `/types` 提供；Host 与 Client 分别编译。Desktop 在切换 Session 或折叠时保留账号标签页。标签页所有权跟随聊天，不绑定单次执行代次。旧版保存账号请求准入仍独立用于配对 MCP 工具。

页面刷新快捷键调用工具栏使用的同一重载操作。其 Tooltip 和 ARIA 组合随有效绑定更新。Desktop 通过所属窗口路由已批准 guest 中的有效快捷键；获焦 webview 必须仍持有该 guest 的租约。Web 保留浏览器专用组合。

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [右侧 Sidebar](../../../docs/subsystems/sidebar-right.zh.md)——tab composition、导航与生命周期。
- [Document Preview](../ui-sidebar-documentpreview/README.zh.md)——本地源码、Markdown、图片、HTML 与 PDF 渲染。
- [Sidebar Browser 决策](../../../.agents/notes/implemented/feature/2026-09-16-sidebar-browser.zh.md)——iframe 行为与 controller 所有权。
- [Desktop Browser 决策](../../../.agents/notes/implemented/feature/2026-09-20-desktop-browser-webview.zh.md)——webview 租约、CWD 存储分组与手动恢复。

-----

<a id="model-experience"></a>
## 模型体验

无，因为本 Client 插件仅提供 Browser 呈现，不注册工具、prompt 或 Session event，也不向模型暴露访问的页面内容。

#### KV Cache 影响

无；浏览内容与人工请求控件不进入模型请求，`website_profiles` 和 `website_prepare` 则由独立的 Desktop Host 注册。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

隔离策略有意放弃部分浏览器兼容性：

- 很多站点拒绝 iframe 嵌入，或需要默认 sandbox 不向 frame 授予的下载与顶层导航。HTTPS 应用还可能按 mixed-content 策略阻止公共 HTTP 页面。关闭 sandbox 会用自身限制换取兼容性，但不会绕过 mixed-content 或 private-network 策略。未受 sandbox 约束的 frame 可以按浏览器 activation 规则导航顶层应用，并使用下载、模态对话框和输入锁定。该模式不会按 Browser tab 隔离被访问 origin 的 Cookie，也无法阻止 iframe 内页面自行选择后续 URL。
- 在 Web 中，逃逸出 sandbox 的 popup 会保留 opener，并可以通过该链导航顶层应用。Desktop 会单独处理 popup 创建。
- 后续 iframe load 能表明发生了导航，但无法给出新的跨域 URL。History API 与 fragment 变化可能仍不可见；状态变成 unknown 后，Web 的后退与前进不可用。
- 出于安全原因，浏览器会隐藏很多 iframe 失败：DNS、TLS、mixed-content、CSP 与 `X-Frame-Options` 失败可能触发 `load`，也可能不提供可操作 event，而不是触发 `error`。加载失败 notice 只能作为 best-effort 提示。
- 普通 tab 只要仍在 Sidebar 布局中，就会跨刷新与插件卸载保留标题/URL 检查点；已保存账户 tab 改为保留 profile id 与配置的起始 URL。关闭 tab 会删除其检查点。重启恢复不恢复页面内存、未保存的表单、Chromium history 或请求授权。
- 本地文件会被拒绝，并继续由 Document Preview 负责。
- 普通 Desktop tab 按规范化的工作区 CWD 共享进程内存储分区；未解析的 Workspace 按 Session 隔离。[本地 HTTPS 设备标签页](../../../apps/desktop/README.zh.md#local-https-devices) 改用全新且限定于源地址的分区；证书接受及登录存储不跨标签页共享，存储切换会在原 guest 实际释放后替换它。已保存账户 tab 使用独立持久分区，认证一直保留到成功退出或遗忘。清理会撤销权限，等待每个 guest 释放，即使同批其他释放失败，然后清除 storage、cache、认证和连接。任何清理等待失败都会保留存储并阻止使用该 profile；中断的清理在重启后仍保持阻止状态。持久化不防止同一 OS 用户读取 Cookie。guest 权限、下载与原生 popup 均被拒绝；通过检查的 HTTP(S) popup 请求会打开 Sidebar tab。Host 地址过滤不是通用私网或 DNS-rebinding 防火墙。
- Desktop Agent 浏览器操作使用原生预览工具集和标签页所有权。旧版保存账号工具保留独立的配对 MCP 授权与结果不确定时的锁。标注选择读取顶层文档，不推断跨源 iframe 内容或框架组件源码位置。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

无。

</details>
