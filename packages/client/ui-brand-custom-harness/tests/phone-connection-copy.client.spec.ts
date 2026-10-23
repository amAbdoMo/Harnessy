/** Owner-local bilingual native companion and legacy operator-access copy expectations. */
import { expect, it } from 'vitest'
import { en, zh } from '../src/client/locales.ts'

it('pins bilingual native companion status, pairing, and task-authority copy', () => {
  const companionCopy = (dictionary: { [Key in keyof typeof en]: string }) => Object.fromEntries(
    Object.entries(dictionary).filter(([key]) => key.startsWith('companion')),
  )
  expect({ en: companionCopy(en), zh: companionCopy(zh) }).toMatchInlineSnapshot(`
    {
      "en": {
        "companionAuthority": "Follow-ups use the PC agent’s permissions. Chat management, opening existing chats, model selection and tool details each require separate approval for this phone. Chats need no open desktop tab. The phone cannot send attachments, approve access, use the terminal or access credentials.",
        "companionConnected": "Connected",
        "companionDescription": "Monitor sessions and send text follow-ups.",
        "companionDisconnected": "Disconnected",
        "companionKeepAwake": "Keep this PC awake and Harnessy running for monitoring and queued follow-ups.",
        "companionOpen": "Phone settings",
        "companionOpenFailed": "Could not open native phone settings. Try again.",
        "companionPairedCount": "{count} paired phones",
        "companionPairing": "Open the Harnessy Android app and link this PC once through Phone settings. Enable the connection, then approve the matching phone fingerprint. Normal startup reconnects automatically; no special launcher is needed.",
        "companionReadFailed": "Could not refresh phone status. Try again.",
        "companionRefresh": "Refresh status",
        "companionRequirements": "Setup, permissions & requirements",
        "companionSetupAttention": "Open Phone settings to enable the connection or check PC access.",
        "companionTitle": "Android phone companion",
        "companionUnavailable": "Unavailable",
        "companionUnavailableDetails": "The connection needs local setup or PC access repair. Existing pairing keys have not been reset.",
      },
      "zh": {
        "companionAuthority": "后续任务沿用电脑智能体的权限。聊天管理、打开已有聊天、模型选择和工具详情分别需要为此手机单独批准，聊天无需在电脑上打开标签页。手机不能发送附件、批准访问、使用终端或访问凭据",
        "companionConnected": "已连接",
        "companionDescription": "监看会话并发送文本后续消息",
        "companionDisconnected": "未连接",
        "companionKeepAwake": "请保持电脑唤醒且 Harnessy 运行，以监看会话并排队发送后续消息",
        "companionOpen": "手机设置",
        "companionOpenFailed": "无法打开原生手机设置，请重试",
        "companionPairedCount": "{count} 台已配对手机",
        "companionPairing": "打开 Harnessy Android 应用，通过手机设置与此电脑配对一次。启用连接，然后批准匹配的手机指纹。普通启动会自动重新连接，无需专用启动器",
        "companionReadFailed": "无法刷新手机状态，请重试",
        "companionRefresh": "刷新状态",
        "companionRequirements": "设置、权限与运行要求",
        "companionSetupAttention": "打开手机设置以启用连接或检查电脑访问",
        "companionTitle": "Android 手机伴侣",
        "companionUnavailable": "不可用",
        "companionUnavailableDetails": "连接需要本地设置或电脑访问修复，现有配对密钥未重置",
      },
    }
  `)
})

it('pins the bilingual phone connection setup and security copy', () => {
  const phoneCopy = (dictionary: { [Key in keyof typeof en]: string }) => Object.fromEntries(
    Object.entries(dictionary).filter(([key]) => key.startsWith('phoneConnection')),
  )
  expect({ en: phoneCopy(en), zh: phoneCopy(zh) }).toMatchInlineSnapshot(`
    {
      "en": {
        "phoneConnectionAccessWarning": "The copied link grants full operator access to this PC’s Harnessy, including sessions, files, and command execution. Share it only with devices you trust.",
        "phoneConnectionClipboardWarning": "The link contains a secret. Clipboard history, sync, and other apps may retain it; clear it after transferring.",
        "phoneConnectionCopied": "Phone connection link copied. Keep it private and clear the clipboard after transferring.",
        "phoneConnectionCopy": "Copy phone connection link",
        "phoneConnectionCopyFailed": "Could not copy the phone connection link. Try again.",
        "phoneConnectionDescription": "Use your phone to operate this running desktop app over your private network.",
        "phoneConnectionDisabled": "Phone access is not configured.",
        "phoneConnectionOpenOnPhone": "Send the copied link privately to your phone and open it in your browser. Keep the desktop app running.",
        "phoneConnectionPrivateServe": "Manually configure private Tailscale Serve to forward that HTTPS root to the local port. Keep your phone and PC on the same tailnet; do not use public Tailscale Funnel.",
        "phoneConnectionReadFailed": "Could not read phone connection settings. Try again.",
        "phoneConnectionSetup": "Set DSH_DESKTOP_REMOTE_URL to your private HTTPS root and DSH_DESKTOP_LISTEN_PORT to a fixed local port, then restart the desktop app.",
        "phoneConnectionTitle": "PC–phone connection",
      },
      "zh": {
        "phoneConnectionAccessWarning": "复制的链接授予对这台电脑上 Harnessy 的完整操作权限，包括会话、文件和命令执行。仅与可信设备共享",
        "phoneConnectionClipboardWarning": "链接包含密钥。剪贴板历史、同步功能及其他应用可能保留它；传送后请清除",
        "phoneConnectionCopied": "手机连接链接已复制。请保密，传送后清除剪贴板",
        "phoneConnectionCopy": "复制手机连接链接",
        "phoneConnectionCopyFailed": "无法复制手机连接链接，请重试",
        "phoneConnectionDescription": "通过私人网络，用手机操作这台电脑上正在运行的桌面应用",
        "phoneConnectionDisabled": "尚未配置手机访问",
        "phoneConnectionOpenOnPhone": "将复制的链接私密传送至手机，并在浏览器中打开。请保持桌面应用运行",
        "phoneConnectionPrivateServe": "手动配置私人 Tailscale Serve，将该 HTTPS 根地址转发至本地端口。手机和电脑须在同一 tailnet 内，请勿使用公开的 Tailscale Funnel",
        "phoneConnectionReadFailed": "无法读取手机连接设置，请重试",
        "phoneConnectionSetup": "将 DSH_DESKTOP_REMOTE_URL 设为私人 HTTPS 根地址，将 DSH_DESKTOP_LISTEN_PORT 设为固定本地端口，然后重启桌面应用",
        "phoneConnectionTitle": "电脑与手机连接",
      },
    }
  `)
})
