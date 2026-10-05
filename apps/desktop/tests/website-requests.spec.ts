import type { WebContents } from 'electron'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import type { DesktopBrowserLeaseId, DesktopWebsiteProfileId } from '@deepseek-ai/dsh-client-ui-sidebar-browser/types'
import { DesktopHostProcess } from '../src/host-process.ts'
import { DesktopWebsiteRequests } from '../src/website-requests.ts'
import type {
  DesktopWebsiteRequestDependencies, DesktopWebsiteRequestGuest, DesktopWebsiteRequestInput,
  DesktopWebsiteRequestReceipt, DesktopWebsiteRequestId,
} from '../src/website-requests.ts'

function host(): DesktopHostProcess {
  return new DesktopHostProcess('node', 'unused-runtime', 'unused-project', undefined, {})
}

// Electron is a system boundary; these fixtures expose only native liveness used by the coordinator.
function contents() {
  let destroyed = false
  const native = { isDestroyed: () => destroyed } as WebContents
  return { native, destroy: () => { destroyed = true } }
}

function fixture() {
  const capturedHost = host()
  let currentHost: DesktopHostProcess | undefined = capturedHost
  const owner = contents()
  const guest = contents()
  const guests = new Map<DesktopBrowserLeaseId, DesktopWebsiteRequestGuest>()
  const spies = {
    reservationChanged: vi.fn<NonNullable<DesktopWebsiteRequestDependencies['reservationChanged']>>(),
    assertProfile: vi.fn<DesktopWebsiteRequestDependencies['assertProfile']>(),
    validate: vi.fn<DesktopWebsiteRequestDependencies['validate']>(async () => {}),
    commit: vi.fn<DesktopWebsiteRequestDependencies['commit']>(),
    revoke: vi.fn<DesktopWebsiteRequestDependencies['revoke']>(),
    drain: vi.fn<DesktopWebsiteRequestDependencies['drain']>(async () => {}),
  }
  const dependencies: DesktopWebsiteRequestDependencies = {
    currentHost: () => currentHost,
    inspectGuest: (_owner, lease) => guests.get(lease),
    ...spies,
  }
  const requests = new DesktopWebsiteRequests(dependencies)
  let sequence = 0
  function prepare(overrides: Partial<DesktopWebsiteRequestInput> = {}) {
    sequence += 1
    const input: DesktopWebsiteRequestInput = {
      requestId: `request-${sequence}` as DesktopWebsiteRequestId,
      host: capturedHost, agentId: 'agent-a', sessionId: 'session-a',
      profile: `profile-${sequence}` as DesktopWebsiteProfileId, url: 'https://portal.example.test/admin',
      mcpServerName: 'website', mcpBinding: { identity: 'binding-a', endpoint: 'https://api.example.test/mcp' },
      owner: owner.native, lease: `lease-${sequence}` as DesktopBrowserLeaseId, ...overrides,
    }
    const native: DesktopWebsiteRequestGuest = { owner: input.owner, guest: guest.native, profile: input.profile,
      attached: true, releasing: false, ownerAuthenticated: true, windowVisible: true, windowMinimized: false }
    guests.set(input.lease, native)
    const id = requests.prepare(input)
    function show(): DesktopWebsiteRequestReceipt {
      const receipt = requests.setVisible(input.owner, id, true)
      if (receipt === undefined) throw new Error('Visible request did not produce a receipt')
      return receipt
    }
    function acknowledge() {
      const receipt = show()
      requests.acknowledge(input.owner, receipt)
      return receipt
    }
    return { input, id, native, show, acknowledge }
  }
  return { requests, dependencies, spies, capturedHost, owner, guest, guests, prepare,
    replaceHost: (replacement: DesktopHostProcess | undefined) => { currentHost = replacement } }
}

describe('Main website request authority', () => {
  it('publishes account reservations during validation and retains them through physical drainage', async () => {
    const f = fixture()
    const a = f.prepare()
    const validation: PromiseWithResolvers<void> = Promise.withResolvers()
    const drained: PromiseWithResolvers<void> = Promise.withResolvers()
    f.dependencies.validate = () => validation.promise
    f.dependencies.drain = () => drained.promise
    const account = { profile: a.input.profile, url: a.input.url, mcpServerName: a.input.mcpServerName, mcpBinding: a.input.mcpBinding }
    const alias = { ...account, profile: 'alias' as DesktopWebsiteProfileId, mcpServerName: 'alias-namespace',
      mcpBinding: { identity: 'other', endpoint: 'https://other.example/mcp' } }
    expect(f.requests.isAccountReserved(account)).toBe(false)
    const resuming = f.requests.resume(a.input.owner, a.acknowledge())
    onTestFinished(async () => {
      validation.resolve()
      drained.resolve()
      await resuming.catch((_error: unknown) => { /* Join cancelled admission before fixture release. */ })
      await f.requests.close(a.id)
    })
    expect(f.spies.reservationChanged).toHaveBeenCalledTimes(1)
    expect(f.requests.isAccountReserved(account)).toBe(true)
    expect(f.requests.isAccountReserved(alias)).toBe(true)
    expect(f.requests.isAccountReserved({ ...alias, url: 'https://unrelated.example/' })).toBe(false)
    validation.resolve()
    await resuming
    const revoking = f.requests.revoke(a.id)
    expect(f.requests.isAccountReserved(alias)).toBe(true)
    expect(f.spies.reservationChanged).toHaveBeenCalledTimes(1)
    drained.resolve()
    await revoking
    expect(f.requests.isAccountReserved(account)).toBe(false)
    expect(f.spies.reservationChanged).toHaveBeenCalledTimes(2)
  })

  it('contains reservation listeners and permits immediate reentrant Takeover', async () => {
    const f = fixture()
    const a = f.prepare()
    let revoked: Promise<void> | undefined
    f.dependencies.reservationChanged = () => {
      revoked = f.requests.revoke(a.id)
      throw new Error('Renderer invalidation failed')
    }
    onTestFinished(async () => { await revoked; await f.requests.close(a.id) })
    await expect(f.requests.resume(a.input.owner, a.acknowledge())).rejects.toThrow('stale')
    await revoked
    expect(f.requests.isAccountReserved(a.input)).toBe(false)
    expect(f.spies.commit).not.toHaveBeenCalled()
  })

  it('composes caller cancellation without releasing the account before physical native settlement', async () => {
    const f = fixture()
    const a = f.prepare()
    const b = f.prepare()
    const physical = Promise.withResolvers<string>()
    const entered = Promise.withResolvers<AbortSignal>()
    const cancellation = new AbortController()
    onTestFinished(async () => { physical.resolve('late'); await f.requests.close(a.id); await f.requests.close(b.id) })
    await f.requests.resume(a.input.owner, a.acknowledge())
    const observed = f.requests.run(f.capturedHost, a.id, cancellation.signal, async (_guest, signal) => {
      entered.resolve(signal)
      return physical.promise
    }).catch((error: unknown) => error)
    const signal = await entered.promise
    cancellation.abort()
    expect(signal.aborted).toBe(true)
    await expect(f.requests.resume(b.input.owner, b.acknowledge())).rejects.toThrow('still draining')
    let settled = false
    const revoke = f.requests.revoke(a.id).then(() => { settled = true })
    await Promise.resolve()
    expect(settled).toBe(false)
    expect(f.spies.drain).not.toHaveBeenCalled()
    physical.resolve('late')
    expect(await observed).toBeInstanceOf(Error)
    await revoke
    expect(f.spies.drain).toHaveBeenCalledTimes(1)
    await f.requests.resume(b.input.owner, b.acknowledge())
  })

  it('never invokes queued work when the caller cancels before its dispatch microtask', async () => {
    const f = fixture()
    const a = f.prepare()
    onTestFinished(async () => { await f.requests.close(a.id) })
    await f.requests.resume(a.input.owner, a.acknowledge())
    const operation = vi.fn(async () => 'forbidden')
    const cancellation = new AbortController()
    const queued = f.requests.run(f.capturedHost, a.id, cancellation.signal, operation)
    cancellation.abort()
    await expect(queued).rejects.toThrow()
    expect(operation).not.toHaveBeenCalled()
  })

  it('retries a hidden-window acknowledgement with the original guest and invalidates its failed receipt', async () => {
    const f = fixture()
    const a = f.prepare()
    const failed = a.show()
    f.guests.set(a.input.lease, { ...a.native, windowVisible: false })
    expect(() =>{  f.requests.acknowledge(a.input.owner, failed) }).toThrow('live visible')
    expect(() => f.requests.prepare(a.input)).toThrow('live visible')
    f.guests.set(a.input.lease, a.native)
    expect(f.requests.prepare(a.input)).toBe(a.id)
    const renewed = a.acknowledge()
    expect(renewed.epoch).toBeGreaterThan(failed.epoch)
    expect(renewed.visibility).not.toBe(failed.visibility)
    expect(() =>{  f.requests.acknowledge(a.input.owner, failed) }).toThrow('stale')
    await expect(f.requests.resume(a.input.owner, failed)).rejects.toThrow('stale')
    await expect(f.requests.run(f.capturedHost, renewed.requestId, new AbortController().signal, async () => 'forbidden')).rejects.toThrow('stale')
    const grant = await f.requests.resume(a.input.owner, renewed)
    await expect(f.requests.run(f.capturedHost, grant.requestId, new AbortController().signal,
      guest => Promise.resolve(guest))).resolves.toBe(f.guest.native)
    await f.requests.close(a.id)
  })

  it.each(['host', 'owner', 'agent', 'session', 'profile', 'url', 'namespace', 'binding', 'endpoint', 'lease', 'guest'] as const)(
    'never renews a revoked request onto another %s', async (changed) => {
      const f = fixture()
      const a = f.prepare()
      await f.requests.revoke(a.id)
      const input = { ...a.input }
      switch (changed) {
        case 'host': input.host = host(); f.replaceHost(input.host); break
        case 'owner': input.owner = contents().native; break
        case 'agent': input.agentId = 'other-agent'; break
        case 'session': input.sessionId = 'other-session'; break
        case 'profile': input.profile = 'other-profile' as DesktopWebsiteProfileId; break
        case 'url': input.url = 'https://other.example.test/'; break
        case 'namespace': input.mcpServerName = 'other-namespace'; break
        case 'binding': input.mcpBinding = { ...input.mcpBinding, identity: 'other-binding' }; break
        case 'endpoint': input.mcpBinding = { ...input.mcpBinding, endpoint: 'https://other.example.test/mcp' }; break
        case 'lease': input.lease = 'other-lease' as DesktopBrowserLeaseId; break
        case 'guest': f.guests.set(input.lease, { ...a.native, guest: contents().native }); break
      }
      expect(() => f.requests.prepare(input)).toThrow(changed === 'guest' ? 'live visible' : 'stale')
      f.replaceHost(f.capturedHost)
      f.guests.set(a.input.lease, a.native)
      expect(f.requests.prepare(a.input)).toBe(a.id)
      await f.requests.close(a.id)
    },
  )

  it('blocks renewal during admission, active grants and drainage, then requires a fresh explicit Resume', async () => {
    const f = fixture()
    const a = f.prepare()
    const entered: PromiseWithResolvers<void> = Promise.withResolvers()
    const validation: PromiseWithResolvers<void> = Promise.withResolvers()
    const draining: PromiseWithResolvers<void> = Promise.withResolvers()
    const drained: PromiseWithResolvers<void> = Promise.withResolvers()
    onTestFinished(() => { validation.resolve(); drained.resolve() })
    f.dependencies.validate = async () => { entered.resolve(); await validation.promise }
    f.dependencies.drain = async () => { draining.resolve(); await drained.promise }
    const first = a.acknowledge()
    const resuming = f.requests.resume(a.input.owner, first)
    await entered.promise
    expect(() => f.requests.prepare(a.input)).toThrow('still draining')
    validation.resolve()
    const grant = await resuming
    expect(() => f.requests.prepare(a.input)).toThrow('still draining')
    const cleanup = f.requests.revoke(a.id)
    await draining.promise
    expect(() => f.requests.prepare(a.input)).toThrow('still draining')
    drained.resolve()
    await cleanup
    expect(f.requests.prepare(a.input)).toBe(a.id)
    const fresh = a.acknowledge()
    await expect(f.requests.run(f.capturedHost, grant.requestId, new AbortController().signal, async () => 'forbidden')).rejects.toThrow('stale')
    await expect(f.requests.run(f.capturedHost, fresh.requestId, new AbortController().signal, async () => 'forbidden')).rejects.toThrow('stale')
    await f.requests.resume(a.input.owner, fresh)
    await f.requests.close(a.id)
  })

  it('retains failed-drainage and closing fences against re-preparation', async () => {
    const f = fixture()
    const a = f.prepare()
    await f.requests.resume(a.input.owner, a.acknowledge())
    f.dependencies.drain = async () => { throw new Error('Unknown physical outcome') }
    await expect(f.requests.revoke(a.id)).rejects.toThrow('account remains locked')
    expect(() => f.requests.prepare(a.input)).toThrow('still draining')
    await expect(f.requests.close(a.id)).rejects.toThrow('account remains locked')
    expect(() => f.requests.prepare(a.input)).toThrow('stale')
  })

  it('adopts the captured Host domain identity and rejects duplicate preparation', async () => {
    const f = fixture()
    const a = f.prepare()
    expect(a.id).toBe(a.input.requestId)
    expect(() => f.requests.prepare(a.input)).toThrow('already prepared')
    await f.requests.close(a.id)
  })

  it.each(['owner', 'lease', 'host', 'profile'] as const)('revokes %s authority synchronously and joins native settlement', async (cause) => {
    const f = fixture()
    const a = f.prepare()
    const grant = await f.requests.resume(a.input.owner, a.acknowledge())
    const entered: PromiseWithResolvers<void> = Promise.withResolvers()
    const settled: PromiseWithResolvers<void> = Promise.withResolvers()
    onTestFinished(() =>{  settled.resolve() })
    const running = f.requests.run(f.capturedHost, grant.requestId, new AbortController().signal, async (_guest, signal) => {
      entered.resolve()
      await settled.promise
      expect(signal.aborted).toBe(true)
    })
    const rejected = expect(running).rejects.toThrow('stale')
    await entered.promise
    const drainage = cause === 'owner' ? f.requests.revokeOwner(a.input.owner)
      : cause === 'lease' ? f.requests.revokeLease(a.input.owner, a.input.lease)
        : cause === 'host' ? f.requests.revokeHost(f.capturedHost) : f.requests.revokeAccount(a.input)
    expect(f.spies.revoke).toHaveBeenCalledOnce()
    expect(() =>{  f.requests.acknowledge(a.input.owner, grant) }).toThrow('stale')
    settled.resolve()
    await rejected
    await drainage
    const fresh = a.acknowledge()
    expect(fresh.visibility).not.toBe(grant.visibility)
    await f.requests.resume(a.input.owner, fresh)
    await f.requests.close(a.id)
  })

  it('prepare and acknowledgement admit no operations; explicit Resume commits only the captured request', async () => {
    const f = fixture()
    const a = f.prepare()
    const operation = vi.fn(async () => 'observed')
    const receipt = a.show()
    await expect(f.requests.resume(a.input.owner, receipt)).rejects.toThrow('not acknowledged')
    await expect(f.requests.run(f.capturedHost, receipt.requestId, new AbortController().signal, operation)).rejects.toThrow('not acknowledged')
    f.requests.acknowledge(a.input.owner, receipt)
    await expect(f.requests.run(f.capturedHost, receipt.requestId, new AbortController().signal, operation)).rejects.toThrow('not acknowledged')
    expect(vi.spyOn(f.dependencies, 'commit')).not.toHaveBeenCalled()
    const grant = await f.requests.resume(a.input.owner, receipt)
    await expect(f.requests.run(f.capturedHost, grant.requestId, new AbortController().signal, operation)).resolves.toBe('observed')
    expect(operation).toHaveBeenCalledWith(f.guest.native, expect.any(AbortSignal))
    expect(vi.spyOn(f.dependencies, 'commit')).toHaveBeenCalledWith(expect.objectContaining({
      requestId: a.id, host: f.capturedHost, profile: a.input.profile, guest: f.guest.native,
      agentId: 'agent-a', sessionId: 'session-a', lease: a.input.lease,
    }), expect.any(AbortSignal))
    await f.requests.close(a.id)
  })

  it.each([
    'missing', 'unattached', 'releasing', 'unauthenticated', 'hidden', 'minimized',
    'wrong-owner', 'wrong-profile', 'destroyed-owner', 'destroyed-guest', 'missing-host',
  ])('refuses acknowledgement for a %s native guest/window/Host', async (condition) => {
    const f = fixture()
    const a = f.prepare()
    const receipt = a.show()
    switch (condition) {
      case 'missing': f.guests.delete(a.input.lease); break
      case 'unattached': f.guests.set(a.input.lease, { ...a.native, attached: false }); break
      case 'releasing': f.guests.set(a.input.lease, { ...a.native, releasing: true }); break
      case 'unauthenticated': f.guests.set(a.input.lease, { ...a.native, ownerAuthenticated: false }); break
      case 'hidden': f.guests.set(a.input.lease, { ...a.native, windowVisible: false }); break
      case 'minimized': f.guests.set(a.input.lease, { ...a.native, windowMinimized: true }); break
      case 'wrong-owner': f.guests.set(a.input.lease, { ...a.native, owner: contents().native }); break
      case 'wrong-profile': f.guests.set(a.input.lease, { ...a.native, profile: 'other' as DesktopWebsiteProfileId }); break
      case 'destroyed-owner': f.owner.destroy(); break
      case 'destroyed-guest': f.guest.destroy(); break
      case 'missing-host': f.replaceHost(undefined); break
    }
    expect(() =>{  f.requests.acknowledge(a.input.owner, receipt) }).toThrow('live visible native guest')
    expect(vi.spyOn(f.dependencies, 'validate')).not.toHaveBeenCalled()
    await f.requests.close(a.id)
  })

  it('authenticates the exact owner and exact receipt rather than trusting lease or request strings', async () => {
    const f = fixture()
    const a = f.prepare()
    const b = f.prepare()
    const receipt = a.show()
    const outsider = contents().native
    expect(() => f.requests.setVisible(outsider, a.id, true)).toThrow('stale')
    expect(() =>{  f.requests.acknowledge(outsider, receipt) }).toThrow('stale')
    await expect(f.requests.resume(outsider, receipt)).rejects.toThrow('stale')
    for (const invalid of [
      { ...receipt, epoch: receipt.epoch + 1 }, { ...receipt, lease: b.input.lease },
      { ...receipt, visibility: b.show().visibility }, { ...receipt, requestId: b.id },
    ]) expect(() =>{  f.requests.acknowledge(a.input.owner, invalid) }).toThrow('stale')
    await f.requests.close(a.id)
    await f.requests.close(b.id)
  })

  it('hide/reopen invalidates late acknowledgements and grants without automatically resuming', async () => {
    const f = fixture()
    const a = f.prepare()
    const first = a.acknowledge()
    const grant = await f.requests.resume(a.input.owner, first)
    expect(f.requests.setVisible(a.input.owner, a.id, false)).toBeUndefined()
    const reopened = a.show()
    expect(reopened.visibility).not.toBe(first.visibility)
    expect(reopened.epoch).toBeGreaterThan(first.epoch)
    expect(() =>{  f.requests.acknowledge(a.input.owner, first) }).toThrow('stale')
    await expect(f.requests.resume(a.input.owner, first)).rejects.toThrow('stale')
    const operation = vi.fn(async () => 'blocked')
    await expect(f.requests.run(f.capturedHost, grant.requestId, new AbortController().signal, operation)).rejects.toThrow('stale')
    await f.requests.revoke(a.id)
    const fresh = a.show()
    await expect(f.requests.resume(a.input.owner, fresh)).rejects.toThrow('not acknowledged')
    expect(vi.spyOn(f.dependencies, 'commit')).toHaveBeenCalledTimes(1)
    f.requests.acknowledge(a.input.owner, fresh)
    await f.requests.resume(a.input.owner, fresh)
    expect(vi.spyOn(f.dependencies, 'commit')).toHaveBeenCalledTimes(2)
    expect(operation).not.toHaveBeenCalled()
    await f.requests.close(a.id)
  })

  it.each(['Host replacement', 'guest replacement', 'native minimize', 'profile cleanup', 'logical hide', 'close']) (
    'rechecks %s after asynchronous validation and never commits a stale Resume', async (race) => {
      const f = fixture()
      const a = f.prepare()
      const entered = Promise.withResolvers<AbortSignal>()
      const validation: PromiseWithResolvers<void> = Promise.withResolvers()
      f.dependencies.validate = vi.fn<DesktopWebsiteRequestDependencies['validate']>((_binding, signal) => {
        entered.resolve(signal); return validation.promise
      })
      const pending = f.requests.resume(a.input.owner, a.acknowledge())
      const rejection = expect(pending).rejects.toThrow()
      const signal = await entered.promise
      let closed: Promise<boolean> | undefined
      switch (race) {
        case 'Host replacement': f.replaceHost(host()); break
        case 'guest replacement': f.guests.set(a.input.lease, { ...a.native, guest: contents().native }); break
        case 'native minimize': f.guests.set(a.input.lease, { ...a.native, windowMinimized: true }); break
        case 'profile cleanup': f.dependencies.assertProfile = () => { throw new Error('Profile clearing') }; break
        case 'logical hide': f.requests.setVisible(a.input.owner, a.id, false); expect(signal.aborted).toBe(true); break
        case 'close': closed = f.requests.close(a.id); expect(signal.aborted).toBe(true); break
      }
      validation.resolve()
      await rejection
      await closed
      expect(vi.spyOn(f.dependencies, 'commit')).not.toHaveBeenCalled()
      expect(vi.spyOn(f.dependencies, 'revoke')).toHaveBeenCalledWith(expect.objectContaining({ host: f.capturedHost, requestId: a.id }))
      expect(vi.spyOn(f.dependencies, 'drain')).toHaveBeenCalledWith(expect.objectContaining({ host: f.capturedHost, requestId: a.id }))
      await f.requests.close(a.id)
    },
  )

  it('hide aborts validation immediately, but a shared-account Resume remains locked until validation and drainage settle', async () => {
    const f = fixture()
    const a = f.prepare()
    const b = f.prepare()
    const entered = Promise.withResolvers<AbortSignal>()
    const validation: PromiseWithResolvers<void> = Promise.withResolvers()
    const draining: PromiseWithResolvers<void> = Promise.withResolvers()
    const drained: PromiseWithResolvers<void> = Promise.withResolvers()
    f.dependencies.validate = (_binding, signal) => { entered.resolve(signal); return validation.promise }
    f.dependencies.drain = () => { draining.resolve(); return drained.promise }
    const first = f.requests.resume(a.input.owner, a.acknowledge())
    const rejection = expect(first).rejects.toThrow('stale')
    const signal = await entered.promise
    f.requests.setVisible(a.input.owner, a.id, false)
    expect(signal.aborted).toBe(true)
    const receiptB = b.acknowledge()
    await expect(f.requests.resume(b.input.owner, receiptB)).rejects.toThrow('still draining')
    validation.resolve()
    await draining.promise
    await expect(f.requests.resume(b.input.owner, receiptB)).rejects.toThrow('still draining')
    drained.resolve()
    await rejection
    f.dependencies.validate = async () => {}
    await f.requests.resume(b.input.owner, receiptB)
    await f.requests.close(a.id)
    await f.requests.close(b.id)
  })

  it.each(['origin', 'namespace', 'configuration', 'endpoint'])('serializes profile aliases sharing an %s', async (shared) => {
    const f = fixture()
    const a = f.prepare()
    const b = f.prepare({ url: shared === 'origin' ? 'https://portal.example.test/other' : 'https://other.example.test/',
      mcpServerName: shared === 'namespace' ? a.input.mcpServerName : 'other-namespace',
      mcpBinding: { identity: shared === 'configuration' ? a.input.mcpBinding.identity : 'different-binding',
        endpoint: shared === 'endpoint' ? a.input.mcpBinding.endpoint : 'https://other-api.example.test/mcp' } })
    expect(a.input.profile).not.toBe(b.input.profile)
    await f.requests.resume(a.input.owner, a.acknowledge())
    const receiptB = b.acknowledge()
    await expect(f.requests.resume(b.input.owner, receiptB)).rejects.toThrow('controlled by another request')
    await f.requests.revokeAccount(b.input)
    expect(() =>{  f.requests.assertGranted(f.capturedHost, a.id) }).toThrow('stale')
    await expect(f.requests.resume(b.input.owner, receiptB)).rejects.toThrow('stale')
    await f.requests.close(a.id)
    await f.requests.resume(b.input.owner, b.acknowledge())
    await f.requests.close(b.id)
  })

  it('allows independent accounts and refuses a grant transplanted onto another request or Host', async () => {
    const f = fixture()
    const a = f.prepare()
    const b = f.prepare({ url: 'https://other.example.test/', mcpServerName: 'other',
      mcpBinding: { identity: 'binding-b', endpoint: 'https://other-api.example.test/mcp' } })
    const grantA = await f.requests.resume(a.input.owner, a.acknowledge())
    const grantB = await f.requests.resume(b.input.owner, b.acknowledge())
    const operation = vi.fn(async () => 'observed')
    await expect(f.requests.resume(b.input.owner, { ...grantA, requestId: b.id })).rejects.toThrow('stale')
    await expect(f.requests.run(host(), grantA.requestId, new AbortController().signal, operation)).rejects.toThrow('stale')
    expect(operation).not.toHaveBeenCalled()
    await expect(f.requests.run(f.capturedHost, grantB.requestId, new AbortController().signal, operation)).resolves.toBe('observed')
    await f.requests.close(a.id)
    await f.requests.close(b.id)
  })

  it('aborts admitted operations synchronously and holds locks through operation settlement and Host drainage', async () => {
    const f = fixture()
    const a = f.prepare()
    const b = f.prepare()
    const grant = await f.requests.resume(a.input.owner, a.acknowledge())
    const entered = Promise.withResolvers<AbortSignal>()
    const operation = Promise.withResolvers<string>()
    const draining: PromiseWithResolvers<void> = Promise.withResolvers()
    const drained: PromiseWithResolvers<void> = Promise.withResolvers()
    f.dependencies.drain = () => { draining.resolve(); return drained.promise }
    const running = f.requests.run(f.capturedHost, grant.requestId, new AbortController().signal, async (_guest, signal) => {
      entered.resolve(signal)
      return operation.promise
    })
    const rejection = expect(running).rejects.toThrow('stale')
    const signal = await entered.promise
    const cleanup = f.requests.revoke(a.id)
    expect(signal.aborted).toBe(true)
    expect(vi.spyOn(f.dependencies, 'revoke')).toHaveBeenCalledTimes(1)
    const receiptB = b.acknowledge()
    await expect(f.requests.resume(b.input.owner, receiptB)).rejects.toThrow('still draining')
    operation.resolve('late result')
    await rejection
    await draining.promise
    await expect(f.requests.resume(b.input.owner, receiptB)).rejects.toThrow('still draining')
    drained.resolve()
    await cleanup
    await f.requests.resume(b.input.owner, receiptB)
    await f.requests.close(a.id)
    await f.requests.close(b.id)
  })

  it('revocation before queued operation dispatch prevents the operation from starting', async () => {
    const f = fixture()
    const a = f.prepare()
    const grant = await f.requests.resume(a.input.owner, a.acknowledge())
    const operation = vi.fn(async () => 'must not run')
    const queued = f.requests.run(f.capturedHost, grant.requestId, new AbortController().signal, operation)
    const rejection = expect(queued).rejects.toThrow('stale')
    await f.requests.revoke(a.id)
    await rejection
    expect(operation).not.toHaveBeenCalled()
    await f.requests.close(a.id)
  })

  it('shares one drainage transaction when an abort listener reenters revocation, retaining failed-cleanup locks', async () => {
    const f = fixture()
    const a = f.prepare()
    const b = f.prepare()
    const grant = await f.requests.resume(a.input.owner, a.acknowledge())
    let reentrantCleanup: Promise<void> | undefined
    await f.requests.run(f.capturedHost, grant.requestId, new AbortController().signal, async (_guest, signal) => {
      signal.addEventListener('abort', () => { reentrantCleanup = f.requests.revoke(a.id) }, { once: true })
    })
    f.dependencies.revoke = vi.fn(() => { throw new Error('Host admission stop failed') })
    const cleanup = f.requests.revoke(a.id)
    expect(reentrantCleanup).toBe(cleanup)
    await expect(cleanup).rejects.toThrow('account remains locked')
    expect(vi.spyOn(f.dependencies, 'revoke')).toHaveBeenCalledTimes(1)
    expect(vi.spyOn(f.dependencies, 'drain')).toHaveBeenCalledTimes(1)
    await expect(f.requests.resume(b.input.owner, b.acknowledge())).rejects.toThrow('still draining')
    await expect(f.requests.close(a.id)).rejects.toThrow('account remains locked')
    await f.requests.close(b.id)
  })

  it.each(['revoke', 'drain'])('contains a throwing %s callback but permanently blocks subsequent account grants', async (failure) => {
    const f = fixture()
    const a = f.prepare()
    const b = f.prepare()
    const grant = await f.requests.resume(a.input.owner, a.acknowledge())
    if (failure === 'revoke') f.dependencies.revoke = () => { throw new Error('Host admission stop failed') }
    else f.dependencies.drain = async () => { throw new Error('Host work did not settle') }
    expect(() => f.requests.setVisible(a.input.owner, a.id, false)).not.toThrow()
    await expect(f.requests.revoke(a.id)).rejects.toThrow('account remains locked')
    await expect(f.requests.resume(b.input.owner, b.acknowledge())).rejects.toThrow('still draining')
    await expect(f.requests.run(f.capturedHost, grant.requestId, new AbortController().signal, async () => 'forbidden')).rejects.toThrow('stale')
    await expect(f.requests.close(a.id)).rejects.toThrow('account remains locked')
    await f.requests.close(b.id)
  })

  it.each(['validate', 'commit'])('drains failed %s before releasing its account reservation', async (failure) => {
    const f = fixture()
    const a = f.prepare()
    const b = f.prepare()
    const draining: PromiseWithResolvers<void> = Promise.withResolvers()
    const drained: PromiseWithResolvers<void> = Promise.withResolvers()
    f.dependencies.drain = () => { draining.resolve(); return drained.promise }
    if (failure === 'validate') f.dependencies.validate = async () => { throw new Error('Exact Session was replaced') }
    else f.dependencies.commit = () => { throw new Error('Exact Agent was replaced') }
    const resume = f.requests.resume(a.input.owner, a.acknowledge())
    const rejection = expect(resume).rejects.toThrow('was replaced')
    await draining.promise
    const receiptB = b.acknowledge()
    await expect(f.requests.resume(b.input.owner, receiptB)).rejects.toThrow('still draining')
    drained.resolve()
    await rejection
    f.dependencies.validate = async () => {}
    f.dependencies.commit = () => {}
    await f.requests.resume(b.input.owner, receiptB)
    await f.requests.close(a.id)
    await f.requests.close(b.id)
  })

  it('does not publish a grant if commit synchronously invalidates its own request', async () => {
    const f = fixture()
    const a = f.prepare()
    f.dependencies.commit = () => { f.requests.setVisible(a.input.owner, a.id, false) }
    await expect(f.requests.resume(a.input.owner, a.acknowledge())).rejects.toThrow('stale')
    await f.requests.close(a.id)
  })

  it('rechecks native guest and profile before operation dispatch and after completion', async () => {
    const f = fixture()
    const a = f.prepare()
    const grant = await f.requests.resume(a.input.owner, a.acknowledge())
    const operation = vi.fn(async () => 'forbidden')
    f.guests.set(a.input.lease, { ...a.native, releasing: true })
    await expect(f.requests.run(f.capturedHost, grant.requestId, new AbortController().signal, operation)).rejects.toThrow('live visible')
    expect(operation).not.toHaveBeenCalled()
    f.guests.set(a.input.lease, a.native)
    await expect(f.requests.run(f.capturedHost, grant.requestId, new AbortController().signal, operation)).rejects.toThrow('stale')
    await f.requests.revoke(a.id)
    const freshGrant = await f.requests.resume(a.input.owner, a.acknowledge())
    await expect(f.requests.run(f.capturedHost, freshGrant.requestId, new AbortController().signal, async () => {
      f.dependencies.assertProfile = () => { throw new Error('Profile clearing') }
      return 'late observation'
    })).rejects.toThrow('Profile clearing')
    await f.requests.close(a.id)
  })

  it.each(['resume', 'native result'] as const)('withholds %s after terminal close between admission and publication', async (publication) => {
    const f = fixture()
    const a = f.prepare()
    let closing: Promise<boolean> | undefined
    onTestFinished(async () => { await closing })
    const closeBeforePublication = () => {
      queueMicrotask(() =>{  queueMicrotask(() => { closing = f.requests.close(a.id) }) })
    }
    if (publication === 'resume') {
      f.spies.commit.mockImplementation(closeBeforePublication)
      await expect(f.requests.resume(a.input.owner, a.acknowledge())).rejects.toThrow('stale')
    } else {
      const grant = await f.requests.resume(a.input.owner, a.acknowledge())
      await expect(f.requests.run(f.capturedHost, grant.requestId, new AbortController().signal, async () => {
        closeBeforePublication()
        return 'withheld observation'
      })).rejects.toThrow('stale')
    }
    expect(closing).toBeDefined()
    await closing
  })

  it.each([false, true])('closes permanently and reports whether Host settlement ran (resumed: %s)', async (resumed) => {
    const f = fixture()
    const a = f.prepare()
    const receipt = a.acknowledge()
    if (resumed) await f.requests.resume(a.input.owner, receipt)
    expect(await f.requests.close(a.id)).toBe(resumed)
    expect(vi.spyOn(f.dependencies, 'drain')).toHaveBeenCalledTimes(Number(resumed))
    expect(() =>{  f.requests.acknowledge(a.input.owner, receipt) }).toThrow('stale')
    expect(() => a.show()).toThrow('stale')
    await expect(f.requests.resume(a.input.owner, receipt)).rejects.toThrow('stale')
    await f.requests.revoke(a.id)
    expect(await f.requests.close(a.id)).toBe(false)
  })
})
