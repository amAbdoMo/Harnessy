---
kind: upgrade-guide
description: "Desktop 浏览器访问使用聊天所属标签页，并将账号控件移出浏览器页头。"
---

# 浏览器标签页控制

[English](guide.md) | 中文

## 变更

Desktop 浏览器工作通过稳定的 `preview_*` 工具访问聊天所属标签页。人工控制期间 Agent 可以观察标签页；人工释放控制后，Agent 可以操作自己所属或尚无归属的标签页。浏览器访问不再要求配对 MCP 服务器或保存网站的准备请求。控制变化会拒绝已排队的操作；人工接管会等待正在运行的操作结束。

浏览器页头移除了 Desktop、Tablet 和 Mobile 按钮，并将保存账号的操作移入折叠菜单。Desktop 默认工具清单以 preview 工具替代 `website_profiles` 和 `website_prepare`。已保存的“每次询问”“自动”和“禁用”选项仅约束显式安装的旧版配对请求；preview 工具对所有账号使用聊天归属和人工控制。Select、Region、Draw 和 Erase 会将标注截图与元素上下文放入聊天草稿。添加反馈不会发送消息。

## 迁移

1. 保留现有应用数据目录和已保存的浏览器账号。主应用与 staging 继续使用独立数据目录；不要在两者之间复制登录信息。
2. 在目标聊天中打开浏览器标签页。使用 `preview_status` 查找标签页标识，使用 `preview_open` 打开新标签页。普通浏览器工作应使用稳定的 preview 工具。
3. 手动操作前选择 Take control，完成后选择 Resume agent。人工接管期间 Agent 仍可检查页面，但不能发起新操作。并行聊天各自使用自己的标签页。
4. 使用标注工具和 Add to chat 暂存反馈，再通过普通输入框检查并发送。
