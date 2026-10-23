/** Main-owned companion dialogs and clipboard; renderer gestures never approve a phone directly. */
import type { IpcMain, IpcMainInvokeEvent, MessageBoxOptions, MessageBoxReturnValue } from 'electron'
import { DESKTOP_IPC } from './ipc.ts'
import type { DesktopCompanionState } from './ipc.ts'
import type { CompanionControlCommand, CompanionControlResult, CompanionStatus, PairedDevice } from '@deepseek-ai/dsh-companion-host/types'

/** One current private Host; no operator URL or token belongs to this interface. */
export interface NativeCompanionHost {
  /** @param command - Closed Main-only management operation. @returns Correlated private result. */
  companionControl(command: CompanionControlCommand): Promise<CompanionControlResult>
}

/** Captured native window and Host incarnations; replacement retires all pending decisions. */
export interface NativeCompanionOwner {
  readonly host: NativeCompanionHost
  readonly window: object
}

interface Operation {
  readonly owner: NativeCompanionOwner
  readonly life: AbortController
}

const en = {
  title: 'Android companion', menu: 'Link your Android phone or manage its access.',
  connected: 'This PC is connected to the secure relay.', offline: 'The PC is not connected to the relay. Pairing needs an online PC.',
  unavailable: 'Phone access is unavailable. Check this Desktop installation and PC access; existing pairing keys were not reset.',
  enable: 'Enable phone connection', enableButton: 'Enable',
  enableDetails: 'Harnessy will connect this PC to its encrypted relay and remember your choice. No phone can read sessions or send tasks until you approve its matching fingerprint. Keep this PC awake and Harnessy running.',
  pair: 'Pair Android phone', requests: 'Approve pairing request', devices: 'Paired phones', close: 'Close',
  cancel: 'Cancel invitation', copied: 'Pairing invitation copied',
  transfer: 'Paste the link into the Harnessy Android app, then choose “Approve pairing request” here. Keep this PC awake.',
  clipboard: 'The invitation contains a one-time secret. Transfer it privately and clear clipboard history or sync copies afterward.',
  authority: 'An approved phone can read existing sessions and queue follow-up tasks. Those tasks can run the PC agent’s existing tools and permissions. The phone cannot approve tools remotely.',
  noRequest: 'No active pairing request. Enter the invitation on the Android phone first; expired invitations require a new link.',
  fingerprint: 'Compare this complete phone fingerprint with the fingerprint displayed in the Android app. Approve only if they match.',
  approve: 'Approve this phone', next: 'Next phone', approved: 'Phone approved. Check the Android app for its connection result.',
  none: 'No paired phones.', remove: 'Remove access', removeTitle: 'Remove phone access?',
  removeWarning: 'New access and queued submissions not yet admitted will be denied. Already admitted PC work continues; removal does not erase previously delivered data.',
  removed: 'Phone access removed.', failed: 'Could not confirm the operation. Refresh paired phones before trying again; do not assume a timed-out approval, removal or permission change was undone.',
  enableManagement: 'Enable chat management', disableManagement: 'Disable chat management',
  enableManagementTitle: 'Enable chat management for this phone?', disableManagementTitle: 'Disable chat management for this phone?',
  managementWarning: 'Allows exactly these chat actions: Create, Rename, Archive and Pin/unpin. Archive preserves chat history; permanent deletion is not supported. This does not grant access to credentials, remote approvals or model controls.',
  disableManagementWarning: 'Withdraws this phone’s Create, Rename, Archive and Pin/unpin permission. Already completed changes are not undone. Reading sessions and sending follow-up tasks stay available while this phone remains paired. Credentials, remote approvals and model controls are not granted.',
  confirm: 'Confirm', cancelDecision: 'Cancel', managementChanged: 'Chat management permission updated.',
  enableModels: 'Enable model selection', disableModels: 'Disable model selection',
  enableModelsTitle: 'Enable model selection for this phone?', disableModelsTitle: 'Disable model selection for this phone?',
  modelsWarning: 'Allows choosing a PC-configured model for a live idle chat. A choice changes only that chat’s next model request, not your global default. This does not grant chat management, account changes, credential access or remote tool approvals.',
  disableModelsWarning: 'Withdraws this phone’s model-selection permission. Already applied choices are not undone. Pairing, chat management and global model defaults are unchanged.',
  modelsChanged: 'Model selection permission updated.',
  enableTools: 'Enable tool details', disableTools: 'Disable tool details',
  enableToolsTitle: 'Enable tool details for this phone?', disableToolsTitle: 'Disable tool details for this phone?',
  toolsWarning: 'Allows file labels and bounded tool status/count summaries from historical and live chat activity. Filenames can be sensitive. It does not grant tool execution, contents, raw commands, credentials or remote approvals.',
  disableToolsWarning: 'Stops future tool-detail delivery. Previously received details cannot be erased. Pairing, model selection and chat management are unchanged.',
  toolsChanged: 'Tool details permission updated.',
  enableActivation: 'Enable opening chats', disableActivation: 'Disable opening chats',
  enableActivationTitle: 'Allow this phone to open existing chats?', disableActivationTitle: 'Stop this phone opening chats?',
  activationWarning: 'Allows explicitly opening existing ordinary chats without a desktop tab. Opening obtains writable Session ownership and runs normal PC initialization and recovery, which can update history or run SessionStart plugins. It does not restore archived chats, rearm goals, send a message, select a model or approve tools. Other permissions remain separate.',
  disableActivationWarning: 'Stops future chat openings. Already opened PC Agents remain running; this does not close chats or cancel admitted work. Pairing and other permissions stay unchanged.',
  activationChanged: 'Chat opening permission updated.',
}
const zh: typeof en = {
  title: 'Android 伴随应用', menu: '连接 Android 手机或管理其访问权限。',
  connected: '这台电脑已连接安全中继。', offline: '电脑未连接中继。配对时电脑必须在线。',
  unavailable: '手机访问不可用。请检查此 Desktop 安装与电脑访问；现有配对密钥未重置。',
  enable: '启用手机连接', enableButton: '启用',
  enableDetails: 'Harnessy 会将此电脑连接到其加密中继，并记住您的选择。只有您批准匹配的指纹后，手机才能读取会话或发送任务。请保持电脑唤醒并运行 Harnessy。',
  pair: '配对 Android 手机', requests: '批准配对请求', devices: '已配对手机', close: '关闭',
  cancel: '取消邀请', copied: '配对邀请已复制',
  transfer: '将链接粘贴到 Harnessy Android 应用，然后在此选择“批准配对请求”。请保持电脑唤醒。',
  clipboard: '邀请含一次性秘密。请私密传送，并在传送后清除剪贴板历史或同步副本。',
  authority: '获准手机可读取现有会话并排队提交后续任务。任务可使用电脑代理现有工具和权限。手机不能远程批准工具。',
  noRequest: '没有有效配对请求。请先在 Android 手机上输入邀请；邀请过期后须创建新链接。',
  fingerprint: '请将完整手机指纹与 Android 应用显示的指纹比较。仅在完全一致时批准。',
  approve: '批准这台手机', next: '下一台手机', approved: '手机已获批准。请在 Android 应用查看连接结果。',
  none: '没有已配对手机。', remove: '移除访问权限', removeTitle: '移除手机访问权限？',
  removeWarning: '新的访问和尚未获准进入收件箱的提交会被拒绝。已获准的电脑任务继续运行；移除权限不会删除先前已传送的数据。',
  removed: '手机访问权限已移除。', failed: '无法确认操作。重试前请刷新已配对手机；不要假定超时的批准、移除或权限更改操作已被撤销。',
  enableManagement: '启用聊天管理', disableManagement: '禁用聊天管理',
  enableManagementTitle: '为这台手机启用聊天管理？', disableManagementTitle: '为这台手机禁用聊天管理？',
  managementWarning: '仅允许这些聊天操作：创建、重命名、归档和置顶/取消置顶。归档会保留聊天历史；不支持永久删除。此权限不允许访问凭据、远程批准或模型控制。',
  disableManagementWarning: '撤销这台手机创建、重命名、归档和置顶/取消置顶聊天的权限。已完成的更改不会撤销。手机保持配对时，仍可读取会话和发送后续任务。此权限不允许访问凭据、远程批准或模型控制。',
  confirm: '确认', cancelDecision: '取消', managementChanged: '聊天管理权限已更新。',
  enableModels: '启用模型选择', disableModels: '禁用模型选择',
  enableModelsTitle: '为这台手机启用模型选择？', disableModelsTitle: '为这台手机禁用模型选择？',
  modelsWarning: '允许为正在运行且空闲的聊天选择电脑端已配置的模型。选择仅影响该聊天的下一次模型请求，不更改全局默认模型。此权限不授予聊天管理、账号更改、凭据访问或远程工具批准权限。',
  disableModelsWarning: '撤销这台手机的模型选择权限。已应用的选择不会撤销，配对、聊天管理和全局默认模型均保持不变。',
  modelsChanged: '模型选择权限已更新。',
  enableTools: '启用工具详情', disableTools: '禁用工具详情',
  enableToolsTitle: '为这台手机启用工具详情？', disableToolsTitle: '为这台手机禁用工具详情？',
  toolsWarning: '允许传送历史及实时聊天活动中的文件标签与有界工具状态／计数摘要。文件名可能敏感。此权限不授予工具执行、内容、原始命令、凭据或远程批准。',
  disableToolsWarning: '停止后续工具详情传送，无法抹去先前已接收的详情。配对、模型选择和聊天管理保持不变。',
  toolsChanged: '工具详情权限已更新。',
  enableActivation: '启用打开聊天', disableActivation: '禁用打开聊天',
  enableActivationTitle: '允许这台手机打开已有聊天？', disableActivationTitle: '停止这台手机打开聊天？',
  activationWarning: '允许显式打开已有普通聊天，无须打开桌面标签页。打开会取得会话写入所有权并执行电脑常规初始化与恢复，可能更新历史或运行 SessionStart 插件。不会恢复已归档聊天、重新启用目标、发送消息、选择模型或批准工具。其他权限仍须单独授予。',
  disableActivationWarning: '阻止后续打开聊天。已打开的电脑 Agent 继续运行，不会关闭聊天或取消已准入的工作。配对与其他权限保持不变。',
  activationChanged: '打开聊天权限已更新。',
}

/** Native presentation injected by Main; every dialog has a captured parent window and abort signal. */
export interface NativeCompanionPresentation {
  /** @param owner - Captured native parent. @param options - Localized dialog and operation cancellation. @returns Native user response. */
  show(owner: NativeCompanionOwner, options: MessageBoxOptions): Promise<MessageBoxReturnValue>
  /** @param text - One-time native invitation. @returns Completion of clipboard access, never a renderer value. */
  copy(text: string): void | Promise<void>
}

/** One native management operation owns every decision; private results never become renderer objects. */
export class DesktopCompanion {
  private active: { readonly operation: Operation; readonly done: Promise<void> } | undefined

  /**
   * @param current - Current window and Host; undefined while quitting or unavailable.
   * @param locale - Current Desktop locale, not phone-supplied text.
   * @param presentation - Main-owned parented native dialogs and clipboard writer.
   */
  constructor(private readonly current: () => NativeCompanionOwner | undefined,
    private readonly locale: () => string, private readonly presentation: NativeCompanionPresentation) {}

  private assertCurrent(operation: Operation): void {
    operation.life.signal.throwIfAborted()
    const current = this.current()
    if (current?.host !== operation.owner.host || current.window !== operation.owner.window) {
      operation.life.abort()
      throw new Error('Companion native owner retired')
    }
  }

  private async description(operation: Operation): Promise<CompanionControlResult> {
    this.assertCurrent(operation)
    const result = await operation.owner.host.companionControl({ kind: 'describe' })
    this.assertCurrent(operation)
    return result
  }

  private async status(operation: Operation): Promise<CompanionStatus> {
    const result = await this.description(operation)
    if (result.kind !== 'status') throw new Error('Companion status unavailable')
    return result.status
  }

  /** @returns Public availability and count only, revalidated against the same native owner after IPC. */
  async describe(): Promise<DesktopCompanionState> {
    const owner = this.current()
    if (owner === undefined) return { available: false, connected: false, pairedCount: 0 }
    const result = await this.description({ owner, life: new AbortController() })
    if (result.kind === 'activationRequired') return { available: false, connected: false, pairedCount: 0 }
    if (result.kind !== 'status') throw new Error('Companion status unavailable')
    return { available: result.status.available, connected: result.status.connected, pairedCount: result.status.paired.length }
  }

  /** @returns Completion of one native management flow; repeated gestures share the same operation. */
  open(): Promise<void> {
    if (this.active !== undefined) return this.active.done
    const owner = this.current()
    if (owner === undefined) return Promise.reject(new Error('Companion native owner unavailable'))
    const operation: Operation = { owner, life: new AbortController() }
    const done = Promise.resolve().then(() => this.manage(operation)).finally(() => {
      if (this.active?.operation === operation) this.active = undefined
    })
    this.active = { operation, done }
    return done
  }

  /** @param host - Retired incarnation; its pending native decisions can no longer authorize a phone. */
  retire(host: NativeCompanionHost): void {
    if (this.active?.operation.owner.host === host) this.active.operation.life.abort()
  }

  /** @returns Settled native operation after dialogs are cancelled; does not stop the Desktop Host. */
  async close(): Promise<void> {
    const active = this.active
    active?.operation.life.abort()
    await active?.done.catch((_error: unknown) => {
      // Retired dialogs cannot complete management; no secret or remote diagnostic is reflected.
    })
  }

  private async dialog(operation: Operation, message: string, buttons: string[], detail?: string): Promise<number> {
    this.assertCurrent(operation)
    const text = this.locale() === 'zh-CN' ? zh : en
    const result = await this.presentation.show(operation.owner, {
      title: text.title, message, buttons, defaultId: buttons.length - 1, cancelId: buttons.length - 1,
      signal: operation.life.signal, ...(detail === undefined ? {} : { detail }), noLink: true,
    })
    this.assertCurrent(operation)
    return result.response
  }

  private async manage(operation: Operation): Promise<void> {
    const text = this.locale() === 'zh-CN' ? zh : en
    try {
      let result = await this.description(operation)
      if (result.kind === 'activationRequired') {
        if (await this.dialog(operation, text.enable, [text.enableButton, text.close], text.enableDetails) !== 0) return
        this.assertCurrent(operation)
        const activation = await operation.owner.host.companionControl({ kind: 'activate' })
        this.assertCurrent(operation)
        if (activation.kind !== 'completed') throw new Error('Companion activation was not confirmed')
        result = await this.description(operation)
      }
      if (result.kind !== 'status') throw new Error('Companion status unavailable')
      const status = result.status
      if (!status.available) { await this.dialog(operation, text.unavailable, [text.close]); return }
      const choice = await this.dialog(operation, text.menu, [text.pair, text.requests, text.devices, text.close],
        `${status.connected ? text.connected : text.offline}\n\n${text.authority}`)
      switch (choice) {
        case 0: await this.pair(operation); return
        case 1: await this.approve(operation); return
        case 2: await this.devices(operation); return
        default: return
      }
    } catch (error) {
      if (operation.life.signal.aborted) return
      this.assertCurrent(operation)
      await this.dialog(operation, text.failed, [text.close])
      throw error
    }
  }

  private async pair(operation: Operation): Promise<void> {
    const text = this.locale() === 'zh-CN' ? zh : en
    if (!(await this.status(operation)).connected) {
      await this.dialog(operation, text.offline, [text.close])
      return
    }
    this.assertCurrent(operation)
    const result = await operation.owner.host.companionControl({ kind: 'createInvitation' })
    this.assertCurrent(operation)
    if (result.kind !== 'invitation') throw new Error('Companion invitation unavailable')
    await this.presentation.copy(result.invitation.pairingUrl)
    this.assertCurrent(operation)
    const choice = await this.dialog(operation, text.copied, [text.requests, text.cancel], `${text.transfer}\n\n${text.clipboard}`)
    if (choice === 0) await this.approve(operation)
    else {
      await operation.owner.host.companionControl({ kind: 'cancelInvitation' })
      this.assertCurrent(operation)
    }
  }

  private async approve(operation: Operation): Promise<void> {
    const text = this.locale() === 'zh-CN' ? zh : en
    const status = await this.status(operation)
    if (status.candidates.length === 0) { await this.dialog(operation, text.noRequest, [text.close]); return }
    let index = 0
    for (;;) {
      const candidate = status.candidates[index]
      if (candidate === undefined) throw new Error('Companion candidate unavailable')
      const choice = await this.dialog(operation, text.fingerprint, [text.approve, text.next, text.cancel, text.close],
        `${candidate.fingerprint}\n\n${text.authority}`)
      if (choice === 1) { index = (index + 1) % status.candidates.length; continue }
      if (choice === 0) {
        await operation.owner.host.companionControl({ kind: 'approveCandidate',
          candidateId: candidate.candidateId, fingerprint: candidate.fingerprint })
        this.assertCurrent(operation)
        await this.dialog(operation, text.approved, [text.close])
      } else if (choice === 2) {
        await operation.owner.host.companionControl({ kind: 'cancelInvitation' })
        this.assertCurrent(operation)
      }
      return
    }
  }

  private async changePermission(operation: Operation, device: PairedDevice,
    kind: 'setSessionManagement' | 'setModelSelection' | 'setToolDetails' | 'setSessionActivation'): Promise<boolean> {
    const text = this.locale() === 'zh-CN' ? zh : en
    const permission = {
      setModelSelection: { enabled: device.modelSelection,
        title: device.modelSelection ? text.disableModelsTitle : text.enableModelsTitle,
        warning: device.modelSelection ? text.disableModelsWarning : text.modelsWarning, changed: text.modelsChanged },
      setToolDetails: { enabled: device.toolDetails,
        title: device.toolDetails ? text.disableToolsTitle : text.enableToolsTitle,
        warning: device.toolDetails ? text.disableToolsWarning : text.toolsWarning, changed: text.toolsChanged },
      setSessionActivation: { enabled: device.sessionActivation,
        title: device.sessionActivation ? text.disableActivationTitle : text.enableActivationTitle,
        warning: device.sessionActivation ? text.disableActivationWarning : text.activationWarning,
        changed: text.activationChanged },
      setSessionManagement: { enabled: device.sessionManagement,
        title: device.sessionManagement ? text.disableManagementTitle : text.enableManagementTitle,
        warning: device.sessionManagement ? text.disableManagementWarning : text.managementWarning, changed: text.managementChanged },
    }[kind]
    if (await this.dialog(operation, permission.title, [text.confirm, text.cancelDecision],
      `${device.fingerprint}\n\n${permission.warning}`) !== 0) return false
    this.assertCurrent(operation)
    const changed = await operation.owner.host.companionControl({ kind, grantId: device.grantId,
      expectedGeneration: device.generation, fingerprint: device.fingerprint, enabled: !permission.enabled })
    this.assertCurrent(operation)
    if (changed.kind !== 'completed') throw new Error('Companion permission change was not confirmed')
    await this.dialog(operation, permission.changed, [text.close])
    return true
  }

  private async devices(operation: Operation): Promise<void> {
    const text = this.locale() === 'zh-CN' ? zh : en
    let index = 0
    for (;;) {
      const status = await this.status(operation)
      if (!status.available) throw new Error('Companion permission status unavailable')
      if (status.paired.length === 0) { await this.dialog(operation, text.none, [text.close]); return }
      index %= status.paired.length
      const device = status.paired[index]
      if (device === undefined) throw new Error('Companion device unavailable')
      const management = device.sessionManagement ? text.disableManagement : text.enableManagement
      const models = device.modelSelection ? text.disableModels : text.enableModels
      const tools = device.toolDetails ? text.disableTools : text.enableTools
      const activation = device.sessionActivation ? text.disableActivation : text.enableActivation
      const choice = await this.dialog(operation, text.devices,
        [management, models, tools, activation, text.remove, text.next, text.close], device.fingerprint)
      if (choice === 5) { index++; continue }
      if (choice === 0 || choice === 1 || choice === 2 || choice === 3) {
        const kind = choice === 0 ? 'setSessionManagement' : choice === 1 ? 'setModelSelection'
          : choice === 2 ? 'setToolDetails' : 'setSessionActivation'
        if (await this.changePermission(operation, device, kind)) continue
        return
      }
      if (choice === 4 && await this.dialog(operation, text.removeTitle, [text.remove, text.close],
        `${device.fingerprint}\n\n${text.removeWarning}`) === 0) {
        await operation.owner.host.companionControl({ kind: 'revokeGrant', grantId: device.grantId })
        this.assertCurrent(operation)
        await this.dialog(operation, text.removed, [text.close])
      }
      return
    }
  }
}

/**
 * Expose only public status and native-window opening to the owned primary document.
 * @param ipc - Main-owned handler registry.
 * @param assertSender - Reject foreign windows, subframes and stale product documents.
 * @param companion - Private native authority; no renderer-supplied command or identifier is accepted.
 * @returns Handler removal; the caller separately retires the native operation.
 */
export function installDesktopCompanionIpc(ipc: Pick<IpcMain, 'handle' | 'removeHandler'>,
  assertSender: (event: IpcMainInvokeEvent) => void, companion: DesktopCompanion): () => void {
  ipc.handle(DESKTOP_IPC.companionDescribe, (event): Promise<DesktopCompanionState> => {
    assertSender(event)
    return companion.describe()
  })
  ipc.handle(DESKTOP_IPC.companionOpen, (event): Promise<void> => {
    assertSender(event)
    return companion.open()
  })
  return () => {
    ipc.removeHandler(DESKTOP_IPC.companionDescribe)
    ipc.removeHandler(DESKTOP_IPC.companionOpen)
  }
}
