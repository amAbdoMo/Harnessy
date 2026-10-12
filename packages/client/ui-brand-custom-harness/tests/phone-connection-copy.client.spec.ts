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
        "companionAuthority": "Follow-up tasks use the existing PC agent’s permissions. The phone cannot create sessions, send attachments, approve access, use the terminal, or change settings.",
        "companionConnected": "Relay connected.",
        "companionDescription": "Monitor existing PC sessions and queue text follow-ups from the native Android app, including away from home through a relay.",
        "companionDisconnected": "Relay disconnected.",
        "companionKeepAwake": "Keep this PC awake and Harnessy running for monitoring and queued follow-ups.",
        "companionOpen": "Open native phone settings",
        "companionOpenFailed": "Could not open native phone settings. Try again.",
        "companionPairedCount": "Paired phones: {count}",
        "companionPairing": "Install the native Android APK from source and pair once in the PC’s native phone settings. Pairing and device removal stay in native dialogs.",
        "companionReadFailed": "Could not refresh phone status. Try again.",
        "companionRefresh": "Refresh status",
        "companionTitle": "Android phone companion",
        "companionUnavailable": "Phone companion is unavailable. The release operator must configure it or resolve a source failure.",
      },
      "zh": {
        "companionAuthority": "后续任务沿用电脑上现有智能体的权限。手机不能新建会话、发送附件、批准访问、使用终端或修改设置",
        "companionConnected": "中继已连接",
        "companionDescription": "通过原生 Android 应用监看电脑上已有的会话，并排队发送文本后续消息；离家后也可通过中继访问",
        "companionDisconnected": "中继未连接",
        "companionKeepAwake": "请保持电脑唤醒且 Harnessy 运行，以监看会话并排队发送后续消息",
        "companionOpen": "打开原生手机设置",
        "companionOpenFailed": "无法打开原生手机设置，请重试",
        "companionPairedCount": "已配对手机：{count}",
        "companionPairing": "安装从源代码构建的原生 Android APK，在电脑的原生手机设置中配对一次。配对与移除设备均由原生对话框处理",
        "companionReadFailed": "无法刷新手机状态，请重试",
        "companionRefresh": "刷新状态",
        "companionTitle": "Android 手机伴侣",
        "companionUnavailable": "手机伴侣不可用，需由发布运营方完成配置或排查源代码故障",
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
