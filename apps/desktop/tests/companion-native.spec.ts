import type { IpcMain, IpcMainInvokeEvent, MessageBoxOptions } from 'electron'
import { describe, expect, it, onTestFinished } from 'vitest'
import { parseId } from '@deepseek-ai/dsh-companion-protocol'
import { parseCompanionControlCommand, parseCompanionControlResult } from '@deepseek-ai/dsh-companion-host/desktop-control'
import type { GrantId, InvitationId, PcId } from '@deepseek-ai/dsh-companion-protocol'
import type { CandidateId, CompanionControlCommand, CompanionControlResult, CompanionStatus } from '@deepseek-ai/dsh-companion-host/types'
import { DesktopCompanion, installDesktopCompanionIpc } from '../src/companion-native.ts'
import type { NativeCompanionHost, NativeCompanionOwner } from '../src/companion-native.ts'
import { DESKTOP_IPC } from '../src/ipc.ts'

const candidates = ['a', 'b'].map(value => ({
  candidateId: parseId<CandidateId>(`candidate-${value}`), fingerprint: value.repeat(64),
  displayName: `phone-${value}`, expiresAt: Number.MAX_SAFE_INTEGER,
}))
const privateStatus: CompanionStatus = {
  available: true, connected: true, pcId: parseId<PcId>('private-pc'),
  paired: [{ grantId: parseId<GrantId>('private-grant'), generation: 1,
    fingerprint: 'c'.repeat(64), displayName: 'private-name', pairedAt: 1, sessionManagement: false, modelSelection: false, toolDetails: false, sessionActivation: false }],
  candidates, invitation: { invitationId: parseId<InvitationId>('private-invitation'), expiresAt: Number.MAX_SAFE_INTEGER },
}
const statusResult: CompanionControlResult = { kind: 'status', status: privateStatus }
const completed: CompanionControlResult = { kind: 'completed' }

type Reply = (command: CompanionControlCommand) => CompanionControlResult | Promise<CompanionControlResult>
type Answer = (options: MessageBoxOptions, index: number) => number | Promise<number>

function native(reply: Reply, answer: Answer = options => options.cancelId ?? 0) {
  const commands: CompanionControlCommand[] = []
  const dialogs: { owner: NativeCompanionOwner; options: MessageBoxOptions }[] = []
  const clipboard: string[] = []
  const release: (() => void)[] = []
  // Only private process IPC is substituted; native management remains real.
  const host: NativeCompanionHost = { companionControl: async (command) => { commands.push(command); return reply(command) } }
  let current: NativeCompanionOwner | undefined = { host, window: {} }
  const companion = new DesktopCompanion(() => current, () => 'en', {
    show: async (owner, options) => {
      dialogs.push({ owner, options })
      return { response: await answer(options, dialogs.length - 1), checkboxChecked: false }
    },
    copy: (text) => { clipboard.push(text) },
  })
  onTestFinished(async () => {
    companion.retire(host)
    for (const finish of release) finish()
    await companion.close()
  })
  return { companion, host, commands, dialogs, clipboard,
    releaseOnCleanup: (finish: () => void) => { release.push(finish) },
    current: () => current, replace: (owner: NativeCompanionOwner | undefined) => { current = owner } }
}

function requireDescribe(command: CompanionControlCommand): CompanionControlResult {
  if (command.kind !== 'describe') throw new Error(`Unexpected private operation: ${command.kind}`)
  return { kind: 'activationRequired' }
}

function responseAt(values: number[]): Answer {
  return (options, index) => values[index] ?? options.cancelId ?? 0
}

type InvokeHandler = Parameters<IpcMain['handle']>[1]
function rendererIpc(companion: DesktopCompanion) {
  const handlers = new Map<string, InvokeHandler>()
  // Electron supplies these event objects; only their identity is needed by this fixture's sender check.
  const trusted = { sender: {} } as IpcMainInvokeEvent
  const foreign = { sender: {} } as IpcMainInvokeEvent
  const remove = installDesktopCompanionIpc({
    handle: (channel, listener) => { handlers.set(channel, listener) },
    removeHandler: (channel) => { handlers.delete(channel) },
  }, (event) => { if (event !== trusted) throw new Error('Foreign renderer') }, companion)
  onTestFinished(remove)
  const invoke = (channel: string, event = trusted, ...args: unknown[]): unknown => {
    const handler = handlers.get(channel)
    if (handler === undefined) throw new Error('Unregistered IPC channel')
    return handler(event, ...args)
  }
  return { handlers, invoke, trusted, foreign, remove }
}

describe('native Desktop companion activation', () => {
  it('defaults and cancels to Close and never activates when enable is declined', async () => {
    const f = native(requireDescribe)
    await f.companion.open()
    expect(f.dialogs).toHaveLength(1)
    expect(f.dialogs[0]?.owner).toBe(f.current())
    expect(f.dialogs[0]?.options).toMatchObject({ buttons: ['Enable', 'Close'], defaultId: 1, cancelId: 1 })
    expect(f.dialogs[0]?.options.detail).toContain('until you approve its matching fingerprint')
    expect(f.commands).toEqual([{ kind: 'describe' }])
    expect(f.clipboard).toEqual([])
  })

  it('shares the open enable dialog and checks actual status after enabling without approving a phone', async () => {
    let enabled = false
    const f = native((command) => {
      if (command.kind === 'describe') return enabled ? statusResult : { kind: 'activationRequired' }
      if (command.kind === 'activate') { enabled = true; return completed }
      throw new Error('Enabling must not authorize or invite a phone')
    }, responseAt([0, 3]))
    const first = f.companion.open()
    expect(f.companion.open()).toBe(first)
    await first
    expect(f.commands).toEqual([{ kind: 'describe' }, { kind: 'activate' }, { kind: 'describe' }])
    expect(f.dialogs).toHaveLength(2)
    expect(f.dialogs[1]?.options.buttons).toContain('Approve pairing request')
    expect(f.clipboard).toEqual([])
    expect(await f.companion.describe()).toEqual({ available: true, connected: true, pairedCount: 1 })
  })

  it.each(['unconfirmed', 'still-needs-activation', 'unavailable'] as const)(
    'does not treat %s activation as ready for pairing', async (outcome) => {
      let enabled = false
      const f = native((command) => {
        if (command.kind === 'activate') {
          enabled = true
          return outcome === 'unconfirmed' ? statusResult : completed
        }
        if (command.kind !== 'describe') throw new Error('No pairing operation is permitted')
        if (!enabled || outcome === 'still-needs-activation') return { kind: 'activationRequired' }
        return { kind: 'status', status: { available: false, connected: false, paired: [], candidates: [] } }
      }, responseAt([0]))
      if (outcome === 'unavailable') await f.companion.open()
      else await expect(f.companion.open()).rejects.toThrow()
      expect(f.commands.map(command => command.kind)).toEqual(outcome === 'unconfirmed'
        ? ['describe', 'activate'] : ['describe', 'activate', 'describe'])
      expect(f.dialogs.at(-1)?.options.buttons).toEqual(['Close'])
      expect(f.clipboard).toEqual([])
    })

  it.each(['window-replaced', 'host-replaced', 'retired', 'closed'] as const)(
    'ignores late Enable after the native owner is %s', async (change) => {
      const shown = Promise.withResolvers<undefined>()
      const answer = Promise.withResolvers<number>()
      const f = native(requireDescribe, async () => { shown.resolve(undefined); return answer.promise })
      f.releaseOnCleanup(() => { answer.resolve(1) })
      const pending = f.companion.open()
      await shown.promise
      const owner = f.current()!
      let closing: Promise<void> | undefined
      if (change === 'window-replaced') f.replace({ host: f.host, window: {} })
      else if (change === 'host-replaced') f.replace({ host: { companionControl: async () => statusResult }, window: owner.window })
      else if (change === 'retired') f.companion.retire(f.host)
      else closing = f.companion.close()
      answer.resolve(0)
      await pending
      await closing
      expect(f.commands).toEqual([{ kind: 'describe' }])
      expect(f.clipboard).toEqual([])
    })

  it.each(['window-replaced', 'retired'] as const)('does not copy an invitation delivered after %s', async (change) => {
    const requested = Promise.withResolvers<undefined>()
    const delivery = Promise.withResolvers<CompanionControlResult>()
    const f = native((command) => {
      if (command.kind === 'describe') return statusResult
      if (command.kind === 'createInvitation') { requested.resolve(undefined); return delivery.promise }
      throw new Error('Unexpected phone operation')
    }, responseAt([0]))
    f.releaseOnCleanup(() => { delivery.resolve(completed) })
    const pending = f.companion.open()
    await requested.promise
    if (change === 'retired') f.companion.retire(f.host)
    else f.replace({ host: f.host, window: {} })
    delivery.resolve({ kind: 'invitation', invitation: {
      invitationId: parseId<InvitationId>('native-only'), expiresAt: Number.MAX_SAFE_INTEGER, pairingUrl: 'harnessy://pair#native-only-secret',
    } })
    await pending
    expect(f.clipboard).toEqual([])
    expect(f.commands.map(command => command.kind)).toEqual(['describe', 'describe', 'createInvitation'])
  })
})

describe('native per-phone chat management consent', () => {
  it.each([false, true])('cancels a permission change from enabled=%s without sending private authority', async (enabled) => {
    const device = { ...privateStatus.paired[0]!, sessionManagement: enabled }
    const f = native((command) => {
      if (command.kind !== 'describe') throw new Error('Cancelled consent cannot mutate authority')
      return { kind: 'status', status: { ...privateStatus, paired: [device] } }
    }, responseAt([2, 0]))
    const ipc = rendererIpc(f.companion)
    await ipc.invoke(DESKTOP_IPC.companionOpen, ipc.trusted, { kind: 'setSessionManagement', grantId: 'forged',
      expectedGeneration: 999, fingerprint: 'f'.repeat(64), enabled: true })
    expect(f.dialogs[1]?.options.buttons?.[0]).toBe(enabled ? 'Disable chat management' : 'Enable chat management')
    expect(f.dialogs[2]?.options).toMatchObject({ buttons: ['Confirm', 'Cancel'], defaultId: 1, cancelId: 1 })
    expect(f.dialogs[2]?.options.detail).toContain(device.fingerprint)
    expect(f.commands).toEqual([{ kind: 'describe' }, { kind: 'describe' }])
    expect(f.clipboard).toEqual([])
  })

  it.each([false, true])('requires native Confirm for enabled=%s and rereads the committed permission before showing it again', async (enabled) => {
    let device = { ...privateStatus.paired[0]!, sessionManagement: enabled }
    const f = native((command) => {
      if (command.kind === 'describe') return { kind: 'status', status: { ...privateStatus, paired: [device] } }
      if (command.kind === 'setSessionManagement') { device = { ...device, sessionManagement: command.enabled }; return completed }
      throw new Error('Unexpected permission operation')
    }, responseAt([2, 0, 0, 0, 6]))
    await f.companion.open()
    expect(f.commands).toEqual([{ kind: 'describe' }, { kind: 'describe' }, {
      kind: 'setSessionManagement', grantId: device.grantId, expectedGeneration: device.generation,
      fingerprint: device.fingerprint, enabled: !enabled,
    }, { kind: 'describe' }])
    const confirmation = f.dialogs[2]!.options
    expect(confirmation).toMatchObject({ buttons: ['Confirm', 'Cancel'], defaultId: 1, cancelId: 1 })
    expect(confirmation.detail).toContain(device.fingerprint)
    for (const action of ['Create', 'Rename', 'Archive', 'Pin/unpin']) expect(confirmation.detail).toContain(action)
    expect(confirmation.detail).not.toContain('Delete and Pin/unpin')
    if (!enabled) expect(confirmation.detail).toContain('permanent deletion is not supported')
    if (!enabled) for (const exclusion of ['credentials', 'remote approvals', 'model controls']) expect(confirmation.detail).toContain(exclusion)
    expect(f.dialogs[4]?.options.buttons?.[0]).toBe(enabled ? 'Enable chat management' : 'Disable chat management')
    expect(f.clipboard).toEqual([])
  })

  it('rereads the roster when Next phone is selected and confirms only the newly displayed identity and generation', async () => {
    const first = privateStatus.paired[0]!
    const second = { ...first, grantId: parseId<GrantId>('second-phone'), fingerprint: 'd'.repeat(64) }
    const fresh = { ...second, generation: 2, fingerprint: 'e'.repeat(64), sessionManagement: true }
    let reads = 0
    const f = native((command) => {
      if (command.kind === 'describe') return { kind: 'status', status: { ...privateStatus,
        paired: ++reads < 3 ? [first, second] : [first, fresh] } }
      if (command.kind === 'setSessionManagement') return completed
      throw new Error('Unexpected permission operation')
    }, responseAt([2, 5, 0, 0, 0, 6]))
    await f.companion.open()
    expect(f.dialogs[2]?.options.detail).toBe(fresh.fingerprint)
    expect(f.commands.filter(command => command.kind === 'setSessionManagement')).toEqual([{
      kind: 'setSessionManagement', grantId: fresh.grantId, expectedGeneration: fresh.generation,
      fingerprint: fresh.fingerprint, enabled: false,
    }])
  })

  it('cannot elevate from a native Confirm delivered after the owner retires', async () => {
    const shown = Promise.withResolvers<undefined>()
    const answer = Promise.withResolvers<number>()
    const f = native((command) => {
      if (command.kind !== 'describe') throw new Error('Retired consent cannot elevate')
      return statusResult
    }, async (_options, index) => {
      if (index === 0) return 2
      if (index === 1) return 0
      shown.resolve(undefined)
      return answer.promise
    })
    f.releaseOnCleanup(() => { answer.resolve(1) })
    const pending = f.companion.open()
    await shown.promise
    f.companion.retire(f.host)
    answer.resolve(0)
    await pending
    expect(f.commands).toEqual([{ kind: 'describe' }, { kind: 'describe' }])
  })

  it('does not report success or silently retry an unconfirmed permission change', async () => {
    const f = native(command => command.kind === 'describe' ? statusResult : { kind: 'activationRequired' }, responseAt([2, 0, 0]))
    await expect(f.companion.open()).rejects.toThrow('permission change was not confirmed')
    expect(f.commands.filter(command => command.kind === 'setSessionManagement')).toHaveLength(1)
    expect(f.dialogs.at(-1)?.options.message).toContain('Could not confirm')
    expect(f.dialogs.some(dialog => dialog.options.message === 'Chat management permission updated.')).toBe(false)
  })
})

describe('native per-phone model selection consent', () => {
  it.each([false, true])('changes only the model permission from enabled=%s after native confirmation', async (enabled) => {
    let device = { ...privateStatus.paired[0]!, modelSelection: enabled }
    const f = native((command) => {
      if (command.kind === 'describe') return { kind: 'status', status: { ...privateStatus, paired: [device] } }
      if (command.kind === 'setModelSelection') { device = { ...device, modelSelection: command.enabled }; return completed }
      throw new Error('Model consent cannot change another capability')
    }, responseAt([2, 1, 0, 0, 6]))
    await f.companion.open()
    expect(f.commands).toEqual([{ kind: 'describe' }, { kind: 'describe' }, {
      kind: 'setModelSelection', grantId: device.grantId, expectedGeneration: device.generation,
      fingerprint: device.fingerprint, enabled: !enabled,
    }, { kind: 'describe' }])
    const consent = f.dialogs[2]!.options
    expect(consent).toMatchObject({ buttons: ['Confirm', 'Cancel'], defaultId: 1, cancelId: 1 })
    expect(consent.detail).toContain(device.fingerprint)
    expect(consent.detail).toContain(enabled ? 'global model defaults are unchanged' : 'not your global default')
    expect(device.sessionManagement).toBe(false)
    expect(f.dialogs[4]?.options.buttons?.[1]).toBe(enabled ? 'Enable model selection' : 'Disable model selection')
    expect(f.clipboard).toEqual([])
  })
})

describe('native per-phone tool detail consent', () => {
  it.each([false, true])('changes only tool details from enabled=%s after fingerprint confirmation', async (enabled) => {
    let device = { ...privateStatus.paired[0]!, toolDetails: enabled, sessionManagement: true, modelSelection: true }
    const f = native((command) => {
      if (command.kind === 'describe') return { kind: 'status', status: { ...privateStatus, paired: [device] } }
      if (command.kind === 'setToolDetails') { device = { ...device, toolDetails: command.enabled }; return completed }
      throw new Error('Tool consent cannot change another permission')
    }, responseAt([2, 2, 0, 0, 6]))
    await f.companion.open()
    expect(f.commands).toEqual([{ kind: 'describe' }, { kind: 'describe' }, {
      kind: 'setToolDetails', grantId: device.grantId, expectedGeneration: device.generation,
      fingerprint: device.fingerprint, enabled: !enabled,
    }, { kind: 'describe' }])
    expect(f.dialogs[2]?.options.detail).toContain(device.fingerprint)
    expect(f.dialogs[2]?.options.detail).toContain(enabled ? 'Previously received details' : 'Filenames can be sensitive')
    expect(device).toMatchObject({ sessionManagement: true, modelSelection: true, toolDetails: !enabled })
    expect(f.clipboard).toEqual([])
  })
})

describe('native per-phone session activation consent', () => {
  it.each([false, true])('changes only opening permission from enabled=%s after full-fingerprint confirmation', async (enabled) => {
    let device = { ...privateStatus.paired[0]!, sessionActivation: enabled,
      sessionManagement: true, modelSelection: true, toolDetails: true }
    const f = native((command) => {
      if (command.kind === 'describe') return { kind: 'status', status: { ...privateStatus, paired: [device] } }
      if (command.kind === 'setSessionActivation') { device = { ...device, sessionActivation: command.enabled }; return completed }
      throw new Error('Opening consent cannot change another permission')
    }, responseAt([2, 3, 0, 0, 6]))
    await f.companion.open()
    expect(f.commands).toEqual([{ kind: 'describe' }, { kind: 'describe' }, {
      kind: 'setSessionActivation', grantId: device.grantId, expectedGeneration: device.generation,
      fingerprint: device.fingerprint, enabled: !enabled,
    }, { kind: 'describe' }])
    expect(f.dialogs[2]?.options.detail).toContain(device.fingerprint)
    expect(f.dialogs[2]?.options.detail).toContain(enabled ? 'Already opened PC Agents remain running' : 'initialization and recovery')
    expect(device).toMatchObject({ sessionManagement: true, modelSelection: true, toolDetails: true, sessionActivation: !enabled })
    expect(f.clipboard).toEqual([])
  })
})

describe('closed private permission IPC parsing', () => {
  const command = { kind: 'setSessionManagement', grantId: 'private-grant', expectedGeneration: 1,
    fingerprint: 'c'.repeat(64), enabled: true }

  it('admits only the complete explicit native permission decision and actual public flag', () => {
    expect(parseCompanionControlCommand(command)).toEqual(command)
    expect(parseCompanionControlCommand({ ...command, kind: 'setModelSelection' })).toEqual({ ...command, kind: 'setModelSelection' })
    expect(parseCompanionControlCommand({ ...command, kind: 'setToolDetails' })).toEqual({ ...command, kind: 'setToolDetails' })
    expect(parseCompanionControlCommand({ ...command, kind: 'setSessionActivation' })).toEqual({ ...command, kind: 'setSessionActivation' })
    expect(parseCompanionControlCommand({ ...command, enabled: false })).toEqual({ ...command, enabled: false })
    expect(parseCompanionControlResult(statusResult, Date.now())).toEqual(statusResult)
  })

  it.each([
    { ...command, enabled: undefined }, { ...command, enabled: 1 }, { ...command, enabled: 'true' },
    { ...command, expectedGeneration: 0 }, { ...command, expectedGeneration: 1.5 }, { ...command, expectedGeneration: 0x100000000 },
    { ...command, fingerprint: 'C'.repeat(64) }, { ...command, fingerprint: 'c'.repeat(63) },
    { ...command, grantId: '' }, { ...command, sessionManagement: true },
    { kind: 'setSessionManagement', grantId: 'private-grant', enabled: true },
  ])('rejects malformed or expanded authority fields %#', (input) => {
    expect(() => parseCompanionControlCommand(input)).toThrow()
  })

  it.each([undefined, null, 'true', 1])('rejects a status permission flag of %s rather than treating it as allowed', (permission) => {
    const paired = privateStatus.paired.map(device => ({ ...device, sessionManagement: permission }))
    expect(() => parseCompanionControlResult({ kind: 'status', status: { ...privateStatus, paired } }, Date.now())).toThrow()
    const invalidModels = privateStatus.paired.map(device => ({ ...device, modelSelection: permission }))
    expect(() => parseCompanionControlResult({ kind: 'status', status: { ...privateStatus, paired: invalidModels } }, Date.now())).toThrow()
    const invalidTools = privateStatus.paired.map(device => ({ ...device, toolDetails: permission }))
    expect(() => parseCompanionControlResult({ kind: 'status', status: { ...privateStatus, paired: invalidTools } }, Date.now())).toThrow()
    const invalidActivation = privateStatus.paired.map(device => ({ ...device, sessionActivation: permission }))
    expect(() => parseCompanionControlResult({ kind: 'status', status: { ...privateStatus, paired: invalidActivation } }, Date.now())).toThrow()
  })
})

describe('native fingerprint approval and renderer IPC', () => {
  it('approves only the exact candidate and full fingerprint shown in the native dialog, ignoring renderer identifiers', async () => {
    const f = native((command) => {
      if (command.kind === 'describe') return statusResult
      if (command.kind === 'approveCandidate') return completed
      throw new Error('Unexpected phone operation')
    }, responseAt([1, 1, 0, 0]))
    const ipc = rendererIpc(f.companion)
    expect([...ipc.handlers.keys()].sort()).toEqual([DESKTOP_IPC.companionDescribe, DESKTOP_IPC.companionOpen].sort())
    await ipc.invoke(DESKTOP_IPC.companionOpen, ipc.trusted, {
      kind: 'approveCandidate', candidateId: 'renderer-selected', fingerprint: 'f'.repeat(64), grantId: 'renderer-grant',
    })
    expect(f.dialogs[1]?.options.detail).toContain('a'.repeat(64))
    expect(f.dialogs[2]?.options.detail).toContain('b'.repeat(64))
    expect(f.dialogs[2]?.options.detail).not.toContain('a'.repeat(64))
    expect(f.commands).toEqual([{ kind: 'describe' }, { kind: 'describe' }, {
      kind: 'approveCandidate', candidateId: candidates[1]!.candidateId, fingerprint: candidates[1]!.fingerprint,
    }])
    expect(f.clipboard).toEqual([])
  })

  it('does not approve a phone when its fingerprint dialog is declined', async () => {
    const f = native((command) => {
      if (command.kind !== 'describe') throw new Error('Decline must not approve a phone')
      return statusResult
    }, responseAt([1, 3]))
    await f.companion.open()
    expect(f.dialogs[1]?.options).toMatchObject({ defaultId: 3, cancelId: 3 })
    expect(f.commands).toEqual([{ kind: 'describe' }, { kind: 'describe' }])
    expect(f.clipboard).toEqual([])
  })

  it('does not approve a fingerprint accepted after the Host retires', async () => {
    const shown = Promise.withResolvers<undefined>()
    const answer = Promise.withResolvers<number>()
    const f = native((command) => {
      if (command.kind !== 'describe') throw new Error('Retired native decision must not approve a phone')
      return statusResult
    }, async (_options, index) => {
      if (index === 0) return 1
      shown.resolve(undefined)
      return answer.promise
    })
    f.releaseOnCleanup(() => { answer.resolve(3) })
    const pending = f.companion.open()
    await shown.promise
    f.companion.retire(f.host)
    answer.resolve(0)
    await pending
    expect(f.commands).toEqual([{ kind: 'describe' }, { kind: 'describe' }])
    expect(f.clipboard).toEqual([])
  })

  it.each(['activation-required', 'ready'] as const)('projects %s private results to exactly three renderer fields', async (phase) => {
    const f = native((command) => {
      if (command.kind !== 'describe') throw new Error('Public status cannot perform a private mutation')
      return phase === 'ready' ? statusResult : { kind: 'activationRequired' }
    })
    const ipc = rendererIpc(f.companion)
    const result = await ipc.invoke(DESKTOP_IPC.companionDescribe, ipc.trusted, { kind: 'activate', arbitrary: 'renderer' })
    expect(result).toEqual(phase === 'ready'
      ? { available: true, connected: true, pairedCount: 1 }
      : { available: false, connected: false, pairedCount: 0 })
    expect(f.commands).toEqual([{ kind: 'describe' }])
    expect(f.dialogs).toEqual([])
    expect(f.clipboard).toEqual([])
  })

  it('rejects foreign senders before native dialogs or private operations and removes its IPC handlers', () => {
    const f = native(requireDescribe)
    const ipc = rendererIpc(f.companion)
    for (const channel of [DESKTOP_IPC.companionOpen, DESKTOP_IPC.companionDescribe]) {
      expect(() => ipc.invoke(channel, ipc.foreign, { kind: 'activate' })).toThrow('Foreign renderer')
    }
    expect(f.commands).toEqual([])
    expect(f.dialogs).toEqual([])
    expect(f.clipboard).toEqual([])
    ipc.remove()
    expect(ipc.handlers.size).toBe(0)
  })
})
