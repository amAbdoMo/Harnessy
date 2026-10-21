---
kind: upgrade-guide
description: "Browser 的桌面、手机和平板模式取代独立的设备预览标签页和开始页入口。"
---

# 响应式预览移入 Browser

[English](guide.md) | 中文

## 变更

独立的**设备预览**标签页和开始页入口被移除。Desktop 用户打开**浏览器**，默认进入**桌面**模式，再选择**手机**或**平板**进行响应式预览。这些模式使用 Chromium CSS 视口和设备外观，不模拟 Android、iOS 或 Safari。已保存的网站账号保持桌面模式，不能成为设备观察目标。

公开的 Sidebar kind `device-preview` 被移除。内部 `ui-device-preview` 包、私有传输和 `device_preview_*` 工具保留原名；这是 Browser UI 迁移，不是工具更名。

## 迁移

1. 从 Sidebar 开始页打开**浏览器**，而不是**设备预览**，然后选择**手机**或**平板**进行响应式预览。通过唯一的地址栏和**前往**导航所选页面；自定义尺寸和图片控件位于**设置**中。
2. 将扩展中的 `ctx.sidebarRight.openTab('device-preview', ...)` 调用改为 Browser 导航。用 `ctx.sidebarRight.openTab('browser', { params: { url } })` 打开 URL，再在 Browser 中选择响应式模式；不要复用已移除的 kind，也不要假设其参数适用于 Browser。
3. 保留现有 `device_preview_*` 工具调用。打开不授予检查权限；每次截图或布局观察仍需重新同意。关闭 Browser 标签页不会停止托管的开发服务器；请单独使用**停止**。
4. 确认开始页提供 Browser 而无独立设备预览入口，新 Browser 标签页默认进入桌面模式，且普通 Desktop 页面可以切换到手机和平板。
