/** Main-owned companion dialogs and clipboard; renderer gestures never approve a phone directly. */
import type { IpcMain, IpcMainInvokeEvent, MessageBoxOptions, MessageBoxReturnValue } from 'electron'
import { DESKTOP_IPC } from './ipc.ts'
import type { DesktopCompanionState } from './ipc.ts'
import type { CompanionControlCommand, CompanionControlResult, CompanionStatus } from '@deepseek-ai/dsh-companion-host/types'

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
  unavailable: 'Phone companion is unavailable. The release operator must configure the relay; a failed PC credential source must be repaired before restarting Harnessy.',
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
  removed: 'Phone access removed.', failed: 'Could not confirm the operation. Refresh paired phones before trying again; do not assume a timed-out approval or removal was undone.',
}
const zh: typeof en = {
  title: 'Android 伴随应用', menu: '连接 Android 手机或管理其访问权限。',
  connected: '这台电脑已连接安全中继。', offline: '电脑未连接中继。配对时电脑必须在线。',
  unavailable: '手机伴随功能不可用。发行运维方必须配置中继；电脑凭证源发生故障时，须先修复再重启 Harnessy。',
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
  removed: '手机访问权限已移除。', failed: '无法确认操作。重试前请刷新已配对手机；不要假定超时的批准或移除操作已被撤销。',
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

  private async status(operation: Operation): Promise<CompanionStatus> {
    this.assertCurrent(operation)
    const result = await operation.owner.host.companionControl({ kind: 'describe' })
    this.assertCurrent(operation)
    if (result.kind !== 'status') throw new Error('Companion status unavailable')
    return result.status
  }

  /** @returns Public availability and count only, revalidated against the same native owner after IPC. */
  async describe(): Promise<DesktopCompanionState> {
    const owner = this.current()
    if (owner === undefined) return { available: false, connected: false, pairedCount: 0 }
    const status = await this.status({ owner, life: new AbortController() })
    return { available: status.available, connected: status.connected, pairedCount: status.paired.length }
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
      const status = await this.status(operation)
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

  private async devices(operation: Operation): Promise<void> {
    const text = this.locale() === 'zh-CN' ? zh : en
    const status = await this.status(operation)
    if (status.paired.length === 0) { await this.dialog(operation, text.none, [text.close]); return }
    let index = 0
    for (;;) {
      const device = status.paired[index]
      if (device === undefined) throw new Error('Companion device unavailable')
      const choice = await this.dialog(operation, text.devices, [text.remove, text.next, text.close], device.fingerprint)
      if (choice === 1) { index = (index + 1) % status.paired.length; continue }
      if (choice === 0 && await this.dialog(operation, text.removeTitle, [text.remove, text.close],
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
