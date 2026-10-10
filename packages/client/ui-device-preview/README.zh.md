---
description: "桌面手机和平板设计预览，提供固定 CSS 视口和显式图片回退。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-device-preview

[English](README.md) | 中文

## 概述

在聊天旁以手机和平板尺寸对比支持 Web 的应用。可选择 iOS 或 Android 设备外观、竖屏或横屏、预设或自定义 CSS 尺寸，以及适应面板或 100% 显示。仅支持原生环境的设计使用明确标注、不可交互且按方向分别选择的图片。设备外观提供视觉参考，不模拟 Android、iOS 或 Safari。

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

桌面右侧 Sidebar 开始页提供**设备预览**。输入 HTTP(S) URL 并选择**开始预览**；两台设备均从该 URL 开始，之后各自独立导航。对比模式展开现有 Sidebar。自定义尺寸接受 240 到 2560 的整数 CSS 像素；适应面板只改变显示缩放，不改变响应式断点。

### 何时选择

需要检查 PWA 和支持 Web 的应用响应式布局时，选择此预览。仅支持原生环境的设计可选择图片；切换方向需要该方向自己的图片，而不会旋转已有截图。普通浏览和已保存网站账号使用[浏览器](../ui-sidebar-browser/README.zh.md)。

### 最小配置

[桌面配置组合](../../bundle/web-app/cordis.patch.yml)负责该条目。本插件没有配置字段，需要桌面私有预览传输和 Browser 的原生页面提供者；普通 Web profile 保持禁用。仅输入 URL 草稿不会开始导航。[桌面预览工具](../../../apps/desktop/README.zh.md#device-preview)分别负责项目准备、启动权限和仅按请求执行的观察。

-----

<a id="understand-the-implementation"></a>
## 了解实现

<details>
<summary>实现细节——点击展开</summary>

[控制器](src/client/controller.ts)为当前打开的预览保留两个普通 Browser 页面。尺寸更新使用固定 Chromium CSS 布局尺寸、DPR1 和物理合成器缩放，不在屏幕上叠加第二次 CSS 变换。隐藏标签页或选择图片会撤销检查可见性，但保留页面；关闭实例会等待页面结束，不停止开发服务器。Agent 新打开预览时会选择 Web 模式并替换前一个预览的 guest，避免已取消的观察关闭新预览；尺寸和方向选择保持不变。物理移除 DOM 可能替换 guest 并丢失原生导航历史。

[视图状态存储](src/client/store.ts)仅包含查看选项、草稿及标签页存续期间的图片。框架绑定的 hook 提供原生页面状态。精确 guest 关联通过 Main 确认后提交；恢复的过期预览标识既不授权自动导航，也不授权观察。[纯类型 IPC 声明](src/types.ts)将 Host 和 Client 编译面分开。

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [右侧 Sidebar](../../../docs/subsystems/sidebar-right.zh.md)——标签页所有权与停靠。
- [浏览器](../ui-sidebar-browser/README.zh.md)——普通原生 guest 和存储策略。
- [桌面](../../../apps/desktop/README.zh.md#device-preview)——启动同意、观察与停止。

-----

<a id="model-experience"></a>
## 模型体验

无，因为本 Client 插件仅注册呈现；独立的 Desktop Host 负责预览工具及其记录结果。

#### KV Cache 影响

无；设备控件和查看选项不进入模型请求。显式 Host 工具结果和请求的截图具有各自的聊天上下文成本。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

预览不能代替目标设备验收：

- 实时渲染使用 Chromium，不是 Safari、Android WebView 或原生 OS API。不模拟用户代理、触摸输入、安全区域行为或设备性能。
- 仅支持原生环境的应用不能在 Web guest 内运行；图片模式不可交互，也不会自动模拟响应式变换。
- 应用重启后不恢复图片或页面历史。预览 URL 遵循普通 Browser 存储策略；已保存账号 guest 永远不是检查目标。
- 人工桌面验收负责小数缩放渲染、指针映射、方向变化和展开的对比模式。仅进行源代码检查不能验证这些原生视觉行为。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

无。

</details>
