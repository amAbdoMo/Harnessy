/** Owner-local bilingual setup, operator-access, and clipboard copy expectations. */
import { expect, it } from 'vitest'
import { en, zh } from '../src/client/locales.ts'

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
