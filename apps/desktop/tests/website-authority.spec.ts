/** Main authority coordinates exact native guests with independent captured Host generations. */
import type { WebContents } from 'electron'
import { randomUUID } from 'node:crypto'
import { setImmediate } from 'node:timers/promises'
import type { DesktopWebsiteHostCommand, DesktopWebsiteHostSnapshot } from '@deepseek-ai/dsh-client-ui-sidebar-browser/types'
import { expect, it, onTestFinished, vi } from 'vitest'
import { websiteAuthorityFixture as fixture } from './website-authority-fixture.ts'

it('permits Human browsing before Resume and fences input, popups and off-origin navigation through physical drainage', async () => {
  const f = fixture()
  f.prepare()
  const receipt = f.authority.prepare(f.owner, f.snapshot().id, f.lease)
  expect(f.authority.allowsNativeNavigation(f.owner, f.lease)).toBe(true)
  expect(f.authority.allowsNativeNavigation(f.owner, f.lease, 'https://other.test/')).toBe(true)
  await f.authority.requests.resume(f.owner, receipt)
  expect(f.profile.control).toBe('human')
  expect(f.authority.allowsNativeNavigation(f.owner, f.lease)).toBe(false)
  expect(f.authority.allowsNativeNavigation(f.owner, f.lease, f.profile.url)).toBe(true)
  expect(f.authority.allowsNativeNavigation(f.owner, f.lease, 'https://other.test/')).toBe(false)
  const entered: PromiseWithResolvers<void> = Promise.withResolvers()
  const drained: PromiseWithResolvers<void> = Promise.withResolvers()
  const original = f.control.getMockImplementation()
  if (original === undefined) throw new Error('Private Host dispatcher missing')
  f.control.mockImplementation(async (command) => {
    if (command.action === 'drain') { entered.resolve(); await drained.promise; return undefined }
    return original(command)
  })
  const takeover = f.authority.takeover(f.profile.id)
  try {
    await entered.promise
    expect(f.authority.allowsNativeNavigation(f.owner, f.lease)).toBe(false)
    expect(f.authority.allowsNativeNavigation(f.owner, f.lease, 'https://other.test/')).toBe(false)
  } finally { drained.resolve(); await takeover }
  expect(f.authority.allowsNativeNavigation(f.owner, f.lease)).toBe(true)
  expect(f.authority.allowsNativeNavigation(f.owner, f.lease, 'https://other.test/')).toBe(true)
})

it('denies native website controls when the exact enrolled guest is unavailable', () => {
  const f = fixture()
  vi.mocked(f.dependencies.guests.inspectWebsite).mockReturnValue(undefined)
  expect(f.authority.allowsNativeNavigation(f.owner, f.lease)).toBe(false)
  expect(f.authority.allowsNativeNavigation(f.owner, f.lease, f.profile.url)).toBe(false)
  expect(f.nativeGuest.getURL).not.toHaveBeenCalled()
  expect(f.nativeGuest.getTitle).not.toHaveBeenCalled()
})

it.each(['same profile', 'origin alias', 'namespace alias', 'binding alias', 'endpoint alias', 'unrelated account'] as const)(
  'fences a sibling guest of %s until the account physically drains', async (kind) => {
    const f = fixture()
    f.prepare()
    await f.authority.requests.resume(f.owner, f.authority.prepare(f.owner, f.snapshot().id, f.lease))
    const sibling = randomUUID() as typeof f.lease
    const binding = f.dependencies.profiles.binding(f.profile.id)
    const alias = { ...f.profile, id: kind === 'same profile' ? f.profile.id : randomUUID() as typeof f.profile.id,
      url: 'https://unrelated.example.test/', mcpServerName: 'unrelated' }
    const aliasBinding = { ...binding, identity: 'unrelated-binding', endpoint: 'https://unrelated.example.test/mcp' }
    if (kind === 'same profile' || kind === 'origin alias') alias.url = f.profile.url
    if (kind === 'same profile' || kind === 'namespace alias') alias.mcpServerName = f.profile.mcpServerName
    if (kind === 'same profile' || kind === 'binding alias') aliasBinding.identity = binding.identity
    if (kind === 'same profile' || kind === 'endpoint alias') aliasBinding.endpoint = binding.endpoint
    vi.mocked(f.dependencies.profiles.assertAvailable).mockImplementation(id => id === alias.id ? alias : f.profile)
    vi.spyOn(f.dependencies.profiles, 'binding').mockImplementation(id => id === alias.id ? aliasBinding : binding)
    const nativeGuest: Pick<WebContents, 'isDestroyed' | 'getURL'> = { isDestroyed: () => false, getURL: () => alias.url }
    const inspect = vi.mocked(f.dependencies.guests.inspectWebsite)
    const original = inspect.getMockImplementation()
    if (original === undefined) throw new Error('Native guest inventory missing')
    inspect.mockImplementation((owner, lease) => lease === sibling ? {
      owner, guest: nativeGuest as WebContents, profile: alias.id,
    } : original(owner, lease))
    const assertFence = (): void => {
      expect(f.authority.projectProfiles([alias])[0]?.control).toBe(kind === 'unrelated account' ? 'human' : 'agent')
      expect(alias.control).toBe('human')
      expect(f.authority.projectProfiles([{ ...alias, control: 'clearing' }])[0]?.control).toBe('clearing')
      expect(f.authority.projectProfiles([{ ...alias, control: 'cleanup-failed' }])[0]?.control).toBe('cleanup-failed')
      expect(f.authority.allowsNativeNavigation(f.owner, sibling)).toBe(kind === 'unrelated account')
      expect(f.authority.allowsNativeNavigation(f.owner, sibling, alias.url)).toBe(kind === 'unrelated account')
      expect(f.authority.allowsNativeNavigation(f.owner, sibling, 'https://other.test/')).toBe(kind === 'unrelated account')
    }
    assertFence()
    const entered: PromiseWithResolvers<void> = Promise.withResolvers()
    const drained: PromiseWithResolvers<void> = Promise.withResolvers()
    const control = f.control.getMockImplementation()
    if (control === undefined) throw new Error('Private Host dispatcher missing')
    f.control.mockImplementation(async (command) => {
      if (command.action === 'drain') { entered.resolve(); await drained.promise; return undefined }
      return control(command)
    })
    const takeover = f.authority.takeover(f.profile.id)
    try { await entered.promise; assertFence() } finally { drained.resolve(); await takeover }
    expect(f.authority.projectProfiles([alias])[0]?.control).toBe('human')
    expect(f.authority.allowsNativeNavigation(f.owner, sibling)).toBe(true)
    expect(f.authority.allowsNativeNavigation(f.owner, sibling, alias.url)).toBe(true)
  },
)

it('projects native page info with independent Host/native epochs and no saved URL path', async () => {
  const f = fixture()
  f.prepare()
  const receipt = f.authority.prepare(f.owner, f.snapshot().id, f.lease)
  const native = await f.authority.requests.resume(f.owner, receipt)
  expect(native.epoch).not.toBe(f.snapshot().epoch)
  vi.spyOn(f.guest, 'getTitle').mockReturnValue('private\u202e title😀'.repeat(100))
  const result = await f.pageInfo()
  expect(result.origin).toBe('https://portal.example.test')
  expect(result.title).not.toContain('\u202e')
  expect(Buffer.byteLength(result.title)).toBeLessThanOrEqual(512)
  expect(result.titleTruncated).toBe(true)
  expect(JSON.stringify(result)).not.toContain('secret')
  expect(vi.spyOn(f.guest, 'getTitle')).toHaveBeenCalledTimes(1)
})

it.each(['pending', 'epoch', 'session', 'profile', 'host', 'guest', 'owner', 'hidden', 'human', 'origin', 'credentials', 'title-authority', 'throw', 'cancel'] as const)(
  'rejects native page-info after %s invalidation without exposing native page data', async (cause) => {
    const f = fixture()
    f.prepare()
    const receipt = f.authority.prepare(f.owner, f.snapshot().id, f.lease)
    if (cause !== 'pending') await f.authority.requests.resume(f.owner, receipt)
    let request = f.snapshot()
    const cancellation = new AbortController()
    let takeover: Promise<void> | undefined
    switch (cause) {
      case 'pending': break
      case 'epoch': request = { ...request, epoch: request.epoch + 1 }; break
      case 'session': request = { ...request, sessionId: 'another-session' as typeof request.sessionId }; break
      case 'profile': request = { ...request, profile: randomUUID() as typeof request.profile }; break
      case 'host': f.replaceHost(); break
      case 'guest': vi.mocked(f.dependencies.guests.inspectWebsite).mockReturnValue({ owner: f.owner,
        guest: { isDestroyed: () => false } as WebContents, profile: f.profile.id }); break
      case 'owner': vi.mocked(f.dependencies.guests.inspectWebsite).mockReturnValue({
        owner: { isDestroyed: () => false } as WebContents, guest: f.guest, profile: f.profile.id }); break
      case 'hidden': vi.mocked(f.window.isVisible).mockReturnValue(false); break
      case 'human': takeover = f.authority.takeover(f.profile.id); break
      case 'origin': vi.spyOn(f.guest, 'getURL').mockReturnValue('https://other.example.test/private?secret'); break
      case 'credentials': vi.spyOn(f.guest, 'getURL').mockReturnValue('https://user:password@portal.example.test/private'); break
      case 'title-authority': vi.spyOn(f.guest, 'getURL').mockImplementation(() => {
        takeover ??= f.authority.takeover(f.profile.id)
        return f.profile.url
      }); break
      case 'throw': vi.spyOn(f.guest, 'getTitle').mockImplementation(() => { throw new Error('secret page title') }); break
      case 'cancel': cancellation.abort(); break
    }
    await expect(f.pageInfo(request, cancellation.signal)).rejects.toThrow('Website observation rejected')
    await takeover
    if (cause !== 'throw') expect(vi.spyOn(f.guest, 'getTitle')).not.toHaveBeenCalled()
  },
)

it('rechecks exact guest and origin after native title collection and again before publication', async () => {
  const f = fixture()
  f.prepare()
  await f.authority.requests.resume(f.owner, f.authority.prepare(f.owner, f.snapshot().id, f.lease))
  vi.spyOn(f.guest, 'getTitle').mockImplementation(() => {
    vi.spyOn(f.guest, 'getURL').mockReturnValue('https://other.example.test/secret')
    return 'secret title'
  })
  await expect(f.pageInfo()).rejects.toThrow('Website observation rejected')
  vi.spyOn(f.guest, 'getURL').mockReturnValue(f.profile.url)
  vi.spyOn(f.guest, 'getTitle').mockImplementation(() => {
    f.replaceHost()
    return 'late title'
  })
  await expect(f.pageInfo()).rejects.toThrow('Website observation rejected')
})

function removal(f: ReturnType<typeof fixture>, request: DesktopWebsiteHostSnapshot): Promise<void> {
  const removed: PromiseWithResolvers<void> = Promise.withResolvers()
  const detach = f.authority.subscribe(() => {
    if (!f.authority.list(request.sessionId).some(item => item.id === request.id)) removed.resolve()
  })
  onTestFinished(detach)
  return removed.promise.then(detach)
}

it('retries a first hidden-window handoff only with the same original visible guest', async () => {
  const f = fixture()
  f.prepare()
  const id = f.snapshot().id
  vi.mocked(f.window.isVisible).mockReturnValue(false)
  expect(() => f.authority.prepare(f.owner, id, f.lease)).toThrow('live visible')
  expect(f.snapshot()).toMatchObject({ epoch: 1, status: 'pending' })
  vi.mocked(f.window.isVisible).mockReturnValue(true)
  const replacement = { isDestroyed: () => false } as WebContents
  vi.mocked(f.dependencies.guests.inspectWebsite).mockReturnValue({ owner: f.owner, guest: replacement, profile: f.profile.id })
  expect(() => f.authority.prepare(f.owner, id, f.lease)).toThrow('live visible')
  vi.mocked(f.dependencies.guests.inspectWebsite).mockReturnValue({ owner: f.owner, guest: f.guest, profile: f.profile.id })
  const receipt = f.authority.prepare(f.owner, id, f.lease)
  expect(receipt.epoch).toBeGreaterThan(0)
  expect(() =>{  f.authority.requests.assertGranted(f.host, id) }).toThrow('stale')
  expect(f.control).not.toHaveBeenCalled()
  const grant = await f.authority.requests.resume(f.owner, receipt)
  await expect(f.authority.requests.run(f.host, grant.requestId, new AbortController().signal, async guest => guest)).resolves.toBe(f.guest)
})

it.each(['hide', 'takeover'] as const)('renews a drained %s with independent epochs and a new explicit Resume', async (cause) => {
  const f = fixture()
  f.prepare()
  const id = f.snapshot().id
  const first = f.authority.prepare(f.owner, id, f.lease)
  const original = await f.authority.requests.resume(f.owner, first)
  if (cause === 'hide') {
    f.authority.requests.setVisible(f.owner, id, false)
    await f.authority.requests.revoke(id)
  } else await f.authority.takeover(f.profile.id)
  const revokedEpoch = f.snapshot().epoch
  expect(f.authority.list(f.snapshot().sessionId)).toMatchObject([{ id, status: 'revoked' }])
  await f.authority.requests.revoke(id)
  const fresh = f.authority.prepare(f.owner, id, f.lease)
  expect(fresh.visibility).not.toBe(first.visibility)
  expect(fresh.epoch).toBeGreaterThan(first.epoch)
  expect(f.snapshot().epoch).toBe(revokedEpoch)
  expect(f.snapshot().status).toBe('revoked')
  expect(() =>{  f.authority.requests.acknowledge(f.owner, first) }).toThrow('stale')
  await expect(f.authority.requests.resume(f.owner, first)).rejects.toThrow('stale')
  await expect(f.authority.requests.run(f.host, fresh.requestId, new AbortController().signal, async () => 'forbidden')).rejects.toThrow('stale')
  const grant = await f.authority.requests.resume(f.owner, fresh)
  expect(f.snapshot()).toMatchObject({ epoch: revokedEpoch, status: 'granted' })
  expect(grant.epoch).not.toBe(f.snapshot().epoch)
  expect(() =>{  f.nativeCheck() }).not.toThrow()
  expect(() =>{  f.nativeCheck({ ...f.snapshot(), epoch: revokedEpoch - 1 }) }).toThrow('stale')
  await expect(f.authority.requests.resume(f.owner, original)).rejects.toThrow('stale')
  await expect(f.authority.requests.run(f.host, grant.requestId, new AbortController().signal, async guest => guest)).resolves.toBe(f.guest)
})

it.each(['origin', 'namespace', 'configuration', 'endpoint'] as const)(
  'takeover of an unprepared alias sharing an %s revokes and drains the active account', async (shared) => {
    const f = fixture()
    const savedBinding = f.dependencies.profiles.binding(f.profile.id)
    const alias = { ...f.profile, id: randomUUID() as typeof f.profile.id,
      url: shared === 'origin' ? 'https://portal.example.test/other' : 'https://other.example.test/',
      mcpServerName: shared === 'namespace' ? f.profile.mcpServerName : 'other-namespace' }
    const aliasBinding = { identity: shared === 'configuration' ? savedBinding.identity : 'different-binding',
      endpoint: shared === 'endpoint' ? savedBinding.endpoint : 'https://other-api.example.test/mcp' }
    vi.mocked(f.dependencies.profiles.assertAvailable).mockImplementation((id) => {
      if (id === f.profile.id) return f.profile
      if (id === alias.id) return alias
      throw new Error('Unknown saved profile')
    })
    f.dependencies.profiles.binding = id => id === alias.id ? aliasBinding : savedBinding
    f.prepare()
    const grant = await f.authority.requests.resume(f.owner, f.authority.prepare(f.owner, f.snapshot().id, f.lease))
    const entered: PromiseWithResolvers<AbortSignal> = Promise.withResolvers()
    const settled: PromiseWithResolvers<void> = Promise.withResolvers()
    const drained: PromiseWithResolvers<void> = Promise.withResolvers()
    const reply = f.control.getMockImplementation()!
    f.control.mockImplementation(async (command) => {
      if (command.action === 'drain') await drained.promise
      return reply(command)
    })
    const running = f.authority.requests.run(f.host, grant.requestId, new AbortController().signal, async (_guest, signal) => {
      entered.resolve(signal)
      await settled.promise
      return 'observed'
    })
    const outcome = running.catch((error: unknown) => error)
    let takeover: Promise<void> | undefined
    try {
      const signal = await entered.promise
      takeover = f.authority.takeover(alias.id)
      let finished = false
      void takeover.then(() => { finished = true }, () => {})
      expect(signal.aborted).toBe(true)
      expect(() =>{  f.nativeCheck() }).toThrow('stale')
      await Promise.resolve()
      expect(finished).toBe(false)
      settled.resolve()
      expect(await outcome).toBeInstanceOf(Error)
      await Promise.resolve()
      expect(finished).toBe(false)
      drained.resolve()
      await takeover
      expect(f.control).toHaveBeenCalledWith({ action: 'revoke', id: f.snapshot().id })
      expect(f.control).toHaveBeenCalledWith({ action: 'drain', id: f.snapshot().id })
    } finally {
      settled.resolve()
      drained.resolve()
      await Promise.allSettled([outcome, ...(takeover === undefined ? [] : [takeover])])
    }
  },
)

it('takeover of an unrelated unprepared account leaves the active account authorized', async () => {
  const f = fixture()
  const savedBinding = f.dependencies.profiles.binding(f.profile.id)
  const unrelated = { ...f.profile, id: randomUUID() as typeof f.profile.id,
    url: 'https://other.example.test/', mcpServerName: 'other-namespace' }
  vi.mocked(f.dependencies.profiles.assertAvailable).mockImplementation(id => id === unrelated.id ? unrelated : f.profile)
  f.dependencies.profiles.binding = id => id === unrelated.id
    ? { identity: 'different-binding', endpoint: 'https://other-api.example.test/mcp' } : savedBinding
  f.prepare()
  const grant = await f.authority.requests.resume(f.owner, f.authority.prepare(f.owner, f.snapshot().id, f.lease))
  await f.authority.takeover(unrelated.id)
  expect(() =>{  f.nativeCheck() }).not.toThrow()
  await expect(f.authority.requests.run(f.host, grant.requestId, new AbortController().signal, async () => 'observed')).resolves.toBe('observed')
  expect(f.control).not.toHaveBeenCalledWith({ action: 'revoke', id: f.snapshot().id })
})

it.each(['owner', 'lease'] as const)('refuses renewal on another valid %s instead of rebinding the Host request', async (changed) => {
  const f = fixture()
  f.prepare()
  const id = f.snapshot().id
  const receipt = f.authority.prepare(f.owner, id, f.lease)
  await f.authority.requests.resume(f.owner, receipt)
  await f.authority.takeover(f.profile.id)
  const owner = changed === 'owner' ? { isDestroyed: () => false, getURL: () => 'dsh-app://app/' } as WebContents : f.owner
  const lease = changed === 'lease' ? randomUUID() as typeof f.lease : f.lease
  vi.mocked(f.dependencies.guests.inspectWebsite).mockReturnValue({ owner, guest: f.guest, profile: f.profile.id })
  expect(() => f.authority.prepare(owner, id, lease)).toThrow('stale')
  vi.mocked(f.dependencies.guests.inspectWebsite).mockReturnValue({ owner: f.owner, guest: f.guest, profile: f.profile.id })
  const fresh = f.authority.prepare(f.owner, id, f.lease)
  await f.authority.requests.resume(f.owner, fresh)
  expect(() =>{  f.nativeCheck() }).not.toThrow()
})

it('refuses preparation while Host admission and physical drainage are pending', async () => {
  const f = fixture()
  f.prepare()
  const id = f.snapshot().id
  const receipt = f.authority.prepare(f.owner, id, f.lease)
  const admission: PromiseWithResolvers<void> = Promise.withResolvers()
  const admitted: PromiseWithResolvers<void> = Promise.withResolvers()
  const drainage: PromiseWithResolvers<void> = Promise.withResolvers()
  const drained: PromiseWithResolvers<void> = Promise.withResolvers()
  onTestFinished(() => { admitted.resolve(); drained.resolve() })
  const reply = f.control.getMockImplementation()!
  f.control.mockImplementation(async (command) => {
    if (command.action === 'validate') { admission.resolve(); await admitted.promise }
    if (command.action === 'drain') { drainage.resolve(); await drained.promise }
    return reply(command)
  })
  const resuming = f.authority.requests.resume(f.owner, receipt)
  await admission.promise
  expect(() => f.authority.prepare(f.owner, id, f.lease)).toThrow('still draining')
  admitted.resolve()
  await resuming
  expect(() => f.authority.prepare(f.owner, id, f.lease)).toThrow('not pending')
  const taking = f.authority.takeover(f.profile.id)
  await drainage.promise
  expect(f.snapshot().status).toBe('revoked')
  expect(() => f.authority.prepare(f.owner, id, f.lease)).toThrow('still draining')
  drained.resolve()
  await taking
  expect(() => f.authority.prepare(f.owner, id, f.lease)).not.toThrow()
})

it('retains failed drainage against renewal even when the captured Host reports revoked', async () => {
  const failure = new Error('Unknown Host physical outcome')
  const f = fixture(new AggregateError([failure], 'Website request drainage failed; account remains locked'))
  f.prepare()
  const id = f.snapshot().id
  const receipt = f.authority.prepare(f.owner, id, f.lease)
  await f.authority.requests.resume(f.owner, receipt)
  const reply = f.control.getMockImplementation()!
  f.control.mockImplementation(async (command) => {
    if (command.action === 'drain') throw failure
    return reply(command)
  })
  await expect(f.authority.takeover(f.profile.id)).rejects.toThrow('drainage failed')
  expect(f.snapshot().status).toBe('revoked')
  expect(() => f.authority.prepare(f.owner, id, f.lease)).toThrow('still draining')
  // Retirement must also retain the failed native transaction, even if later Host calls could succeed.
  f.control.mockImplementation(reply)
  const stopped = f.detachHost()
  expect(() => f.authority.prepare(f.owner, id, f.lease)).toThrow('not pending')
  await expect(stopped).rejects.toThrow('retirement failed')
  expect(f.control.mock.calls.some(([command]) => command.action === 'remove')).toBe(false)
  await expect(f.authority.dispose()).rejects.toThrow('teardown failed')
})

it('refuses renewal when a revoked request becomes terminal and after retirement removes it', async () => {
  const f = fixture()
  f.prepare()
  const request = f.snapshot()
  const receipt = f.authority.prepare(f.owner, request.id, f.lease)
  await f.authority.requests.resume(f.owner, receipt)
  await f.authority.takeover(f.profile.id)
  const removed = removal(f, request)
  f.terminate()
  expect(() => f.authority.prepare(f.owner, request.id, f.lease)).toThrow('not pending')
  await removed
  expect(() => f.authority.prepare(f.owner, request.id, f.lease)).toThrow('different captured Host')
})

it('requires captured Host preparation and explicit native Resume with independent epochs', async () => {
  const f = fixture()
  expect(() => f.authority.prepare(f.owner, f.snapshot().id, f.lease)).toThrow('different captured Host')
  f.prepare()
  const receipt = f.authority.prepare(f.owner, f.snapshot().id, f.lease)
  expect(receipt.epoch).toBe(0)
  expect(f.snapshot().epoch).toBe(1)
  const observe = vi.fn(async () => 'observed')
  await expect(f.authority.requests.run(f.host, receipt.requestId, new AbortController().signal, observe)).rejects.toThrow('stale')
  const grant = await f.authority.requests.resume(f.owner, receipt)
  expect(f.control.mock.calls.map(([command]) => command)).toEqual([
    { action: 'validate', id: receipt.requestId, epoch: 1 }, { action: 'commit', id: receipt.requestId, epoch: 1 },
  ])
  expect(await f.authority.requests.run(f.host, grant.requestId, new AbortController().signal, observe)).toBe('observed')
  expect(observe).toHaveBeenCalledExactlyOnceWith(f.guest, expect.any(AbortSignal))
  await f.authority.takeover(f.profile.id)
  await expect(f.authority.requests.run(f.host, grant.requestId, new AbortController().signal, observe)).rejects.toThrow('stale')
})

it('retires a terminal Host preparation whose native handoff was refused or cancelled', async () => {
  const f = fixture()
  const request = f.snapshot()
  const removed = removal(f, request)
  f.terminate(request)
  expect(f.authority.list(request.sessionId)).toMatchObject([{ id: request.id, terminal: true, status: 'revoked' }])
  expect(() => f.authority.prepare(f.owner, request.id, f.lease)).toThrow('not pending')
  await removed
  expect(f.control.mock.calls.map(([command]) => command.action)).toEqual(['revoke', 'drain', 'remove'])
  expect(f.authority.list(request.sessionId)).toEqual([])
})

it('checks the exact live native grant for each Host operation, including loss without a window event', async () => {
  const f = fixture()
  f.prepare()
  const receipt = f.authority.prepare(f.owner, f.snapshot().id, f.lease)
  expect(() =>{  f.nativeCheck({ ...f.snapshot(), status: 'granted' }) }).toThrow('stale')
  await f.authority.requests.resume(f.owner, receipt)
  expect(() =>{  f.nativeCheck() }).not.toThrow()
  expect(() =>{  f.nativeCheck({ ...f.snapshot(), epoch: 2 }) }).toThrow('stale')
  vi.mocked(f.window.isVisible).mockReturnValue(false)
  expect(() =>{  f.nativeCheck() }).toThrow('live visible')
  vi.mocked(f.window.isVisible).mockReturnValue(true)
  expect(() =>{  f.nativeCheck() }).toThrow()
})

it('never attaches an unowned guest or a renderer-guessed Host identity', () => {
  const f = fixture()
  f.prepare()
  expect(() => f.authority.prepare({ isDestroyed: () => false } as WebContents, f.snapshot().id, f.lease)).toThrow('approved attached')
  expect(() => f.authority.prepare(f.owner, 'af1bdcbb-c283-4a35-9a6c-cac226f903b7' as DesktopWebsiteHostSnapshot['id'], f.lease))
    .toThrow('different captured Host')
})

it('awaits pending Host commit acknowledgement before takeover can release the account', async () => {
  const f = fixture()
  f.prepare()
  const receipt = f.authority.prepare(f.owner, f.snapshot().id, f.lease)
  const entered: PromiseWithResolvers<void> = Promise.withResolvers()
  const finished: PromiseWithResolvers<void> = Promise.withResolvers()
  onTestFinished(() =>{  finished.resolve() })
  const reply = f.control.getMockImplementation()!
  f.control.mockImplementation(async (command: DesktopWebsiteHostCommand) => {
    if (command.action === 'commit') { entered.resolve(); await finished.promise }
    return reply(command)
  })
  const resuming = f.authority.requests.resume(f.owner, receipt)
  const rejected = expect(resuming).rejects.toThrow()
  await entered.promise
  const taking = f.authority.takeover(f.profile.id)
  const drained = vi.fn()
  void taking.then(drained)
  await Promise.resolve()
  expect(drained).not.toHaveBeenCalled()
  finished.resolve()
  await rejected
  await taking
  expect(drained).toHaveBeenCalledOnce()
})

it('invalidates a committed native grant when this exact Host reports revocation', async () => {
  const f = fixture()
  f.prepare()
  const receipt = f.authority.prepare(f.owner, f.snapshot().id, f.lease)
  const grant = await f.authority.requests.resume(f.owner, receipt)
  f.revoke()
  const observation = vi.fn(async () => 'forbidden')
  await expect(f.authority.requests.run(f.host, grant.requestId, new AbortController().signal, observation)).rejects.toThrow('stale')
  expect(observation).not.toHaveBeenCalled()
  await f.authority.requests.revoke(receipt.requestId)
})

it('revokes native authority before subscribers observe a Host revocation', async () => {
  const f = fixture()
  f.prepare()
  const receipt = f.authority.prepare(f.owner, f.snapshot().id, f.lease)
  const grant = await f.authority.requests.resume(f.owner, receipt)
  const started = Promise.withResolvers<AbortSignal>()
  const finished: PromiseWithResolvers<void> = Promise.withResolvers()
  onTestFinished(() =>{  finished.resolve() })
  const work = f.authority.requests.run(f.host, grant.requestId, new AbortController().signal, async (_guest, signal) => {
    started.resolve(signal)
    await finished.promise
    return 'withheld'
  })
  const signal = await started.promise
  const observations: { aborted: boolean; admitted: boolean }[] = []
  const detach = f.authority.subscribe(() => {
    if (f.authority.list(f.snapshot().sessionId)[0]?.status !== 'revoked') return
    let admitted = true
    try { f.authority.requests.assertGranted(f.host, grant.requestId) }
    catch (_error) { admitted = false }
    observations.push({ aborted: signal.aborted, admitted })
  })
  onTestFinished(detach)
  f.revoke()
  expect(observations[0]).toEqual({ aborted: true, admitted: false })
  finished.resolve()
  await expect(work).rejects.toThrow('stale')
})

it('lists only the captured current Host and requested Session without exposing mutable saved snapshots', () => {
  const f = fixture()
  f.prepare()
  f.prepare({ ...f.snapshot(), id: 'af1bdcbb-c283-4a35-9a6c-cac226f903b7' as DesktopWebsiteHostSnapshot['id'],
    sessionId: 'other-session' as DesktopWebsiteHostSnapshot['sessionId'] })
  const listed = f.authority.list(f.snapshot().sessionId)
  expect(listed).toEqual([f.snapshot()])
  listed.forEach((item) => { Object.assign(item, { status: 'granted' }) })
  expect(f.authority.list(f.snapshot().sessionId)[0]?.status).toBe('pending')
  f.replaceHost()
  expect(f.authority.list(f.snapshot().sessionId)).toEqual([])
})

it('limits outstanding captures rather than the number of settled requests in a Host lifetime', async () => {
  const f = fixture()
  for (let index = 0; index < 65; index++) {
    const request = { ...f.snapshot(), id: randomUUID() as DesktopWebsiteHostSnapshot['id'] }
    f.prepare(request)
    expect(f.authority.list(request.sessionId)).toHaveLength(1)
    const removed = removal(f, request)
    f.terminate(request)
    await removed
  }
  expect(f.control.mock.calls.filter(([command]) => command.action === 'remove')).toHaveLength(65)
  for (let index = 0; index < 64; index++) {
    f.prepare({ ...f.snapshot(), id: randomUUID() as DesktopWebsiteHostSnapshot['id'] })
  }
  expect(() =>{  f.prepare({ ...f.snapshot(), id: randomUUID() as DesktopWebsiteHostSnapshot['id'] }) }).toThrow('limit')
  expect(f.authority.list(f.snapshot().sessionId)).toHaveLength(64)
})

it.each(['captured', 'prepared', 'granted'])('retires owner-ended %s requests without retaining a resumable identity', async (state) => {
  const f = fixture()
  f.prepare()
  const request = f.snapshot()
  if (state !== 'captured') {
    const receipt = f.authority.prepare(f.owner, request.id, f.lease)
    if (state === 'granted') await f.authority.requests.resume(f.owner, receipt)
  }
  const removed = removal(f, request)
  f.terminate()
  expect(() =>{  f.authority.requests.assertGranted(f.host, request.id) }).toThrow()
  expect(() => f.authority.prepare(f.owner, request.id, f.lease)).toThrow('not pending')
  await removed
  expect(f.authority.list(request.sessionId)).toEqual([])
  expect(f.control).toHaveBeenCalledWith({ action: 'drain', id: request.id })
  expect(f.control).toHaveBeenCalledWith({ action: 'remove', id: request.id })
})

it('fences stopped-Host captures immediately and retires even requests without native preparation', async () => {
  const f = fixture()
  f.prepare()
  const request = f.snapshot()
  const stopping = f.detachHost()
  expect(() => f.authority.prepare(f.owner, request.id, f.lease)).toThrow('not pending')
  expect(() =>{  f.prepare({ ...request, id: randomUUID() as DesktopWebsiteHostSnapshot['id'] }) }).toThrow('unavailable Host')
  await stopping
  expect(f.authority.list(request.sessionId)).toEqual([])
  expect(f.control.mock.calls.map(([command]) => command.action)).toEqual(['revoke', 'drain', 'remove'])
})

it.each([false, true])('joins late terminal cleanup during Host teardown (failed drainage: %s)', async (failed) => {
  const failure = new Error('Late Host request drainage failed')
  const f = fixture(failed ? failure : undefined)
  f.prepare()
  const request = f.snapshot()
  const late: DesktopWebsiteHostSnapshot = { ...request, id: randomUUID() as DesktopWebsiteHostSnapshot['id'],
    status: 'revoked', terminal: true }
  const firstEntered: PromiseWithResolvers<void> = Promise.withResolvers()
  const firstRelease: PromiseWithResolvers<void> = Promise.withResolvers()
  const lateEntered: PromiseWithResolvers<void> = Promise.withResolvers()
  const lateRelease: PromiseWithResolvers<void> = Promise.withResolvers()
  onTestFinished(() => { firstRelease.resolve(); lateRelease.resolve() })
  const reply = f.control.getMockImplementation()!
  const order: string[] = []
  f.control.mockImplementation(async (command) => {
    if (command.action === 'drain') {
      if (command.id === request.id) { firstEntered.resolve(); await firstRelease.promise }
      else { lateEntered.resolve(); await lateRelease.promise; if (failed) throw failure }
    }
    if (command.action === 'remove' && command.id === late.id) order.push('late removed')
    return reply(command)
  })
  const removed = removal(f, request)
  const stopping = f.detachHost().then(() => { order.push('stopped'); return undefined }, (error: unknown) => error)
  await firstEntered.promise
  f.notifyRevocation(late)
  await lateEntered.promise
  expect(() => f.authority.prepare(f.owner, late.id, f.lease)).toThrow('not pending')
  firstRelease.resolve()
  await removed
  // Drain runnable promise continuations while the late request remains blocked on its owned barrier.
  await setImmediate()
  try { expect(order).toEqual([]) }
  finally { lateRelease.resolve(); await stopping }
  const outcome = await stopping
  if (failed) {
    expect(outcome).toMatchObject({ errors: [failure] })
    expect(f.authority.list(request.sessionId)).toEqual([late])
    expect(order).toEqual([])
  } else {
    expect(outcome).toBeUndefined()
    expect(f.authority.list(request.sessionId)).toEqual([])
    expect(order).toEqual(['late removed', 'stopped'])
  }
})

it('keeps terminal captures until the Host confirms physical settlement', async () => {
  const f = fixture()
  f.prepare()
  const request = f.snapshot()
  const entered: PromiseWithResolvers<void> = Promise.withResolvers()
  const finished: PromiseWithResolvers<void> = Promise.withResolvers()
  onTestFinished(() =>{  finished.resolve() })
  const reply = f.control.getMockImplementation()!
  f.control.mockImplementation(async (command) => {
    if (command.action === 'drain') { entered.resolve(); await finished.promise }
    return reply(command)
  })
  const removed = removal(f, request)
  f.terminate()
  await entered.promise
  expect(f.authority.list(request.sessionId)).toMatchObject([{ id: request.id, terminal: true }])
  expect(f.control.mock.calls.some(([command]) => command.action === 'remove')).toBe(false)
  expect(() => f.authority.prepare(f.owner, request.id, f.lease)).toThrow('not pending')
  finished.resolve()
  await removed
})

it('retains failed terminal settlement instead of removing the Host request on stop or replacement', async () => {
  const failure = new Error('Physical MCP outcome is unknown')
  const f = fixture(failure)
  f.prepare()
  const request = f.snapshot()
  const entered: PromiseWithResolvers<void> = Promise.withResolvers()
  const reply = f.control.getMockImplementation()!
  f.control.mockImplementation(async (command) => {
    if (command.action === 'drain') { entered.resolve(); throw failure }
    return reply(command)
  })
  f.terminate()
  await entered.promise
  await expect(f.detachHost()).rejects.toMatchObject({ errors: [failure] })
  expect(f.authority.list(request.sessionId)).toMatchObject([{ id: request.id, terminal: true }])
  expect(f.control.mock.calls.some(([command]) => command.action === 'remove')).toBe(false)
  f.replaceHost()
  await expect(f.authority.dispose()).rejects.toMatchObject({ errors: [{ errors: [failure] }] })
  expect(f.control.mock.calls.some(([command]) => command.action === 'remove')).toBe(false)
})

it.each(['captured', 'granted'] as const)('settles a %s request when terminal revocation overtakes its private revoke reply', async (state) => {
  const f = fixture()
  const request = f.snapshot()
  f.prepare()
  let grant
  if (state === 'granted') {
    const receipt = f.authority.prepare(f.owner, request.id, f.lease)
    grant = await f.authority.requests.resume(f.owner, receipt)
  }
  const retired = removal(f, request)
  const reply = f.control.getMockImplementation()!
  f.control.mockImplementation(async (command) => {
    const result = await reply(command)
    if (command.action === 'revoke' && result !== undefined) f.terminate(result)
    return result
  })
  if (state === 'granted') await f.authority.takeover(f.profile.id)
  else await f.detachHost()
  await retired
  expect(f.authority.list(request.sessionId)).toEqual([])
  const observe = vi.fn(async () => 'observed')
  if (grant !== undefined) {
    await expect(f.authority.requests.run(f.host, grant.requestId, new AbortController().signal, observe)).rejects.toThrow()
  }
  expect(observe).not.toHaveBeenCalled()
})

it.each<{ name: string; patch: Partial<DesktopWebsiteHostSnapshot> }>([
  { name: 'another request', patch: { id: 'af1bdcbb-c283-4a35-9a6c-cac226f903b7' as DesktopWebsiteHostSnapshot['id'] } },
  { name: 'another profile', patch: { profile: '07275b7a-ab10-4445-bb1a-221cbf0a3621' as DesktopWebsiteHostSnapshot['profile'] } },
  { name: 'another Session', patch: { sessionId: 'other-session' as DesktopWebsiteHostSnapshot['sessionId'] } },
  { name: 'pending authority', patch: { status: 'pending' } },
  { name: 'granted authority', patch: { status: 'granted' } },
])('retains the original capture when an overtaken revoke reply reports $name', async ({ patch }) => {
  const failure = new Error(patch.status === undefined
    ? 'Website Host response changed its captured request owner or generation'
    : 'Website revocation returned an active request')
  const f = fixture(failure)
  f.prepare()
  const request = f.snapshot()
  const reply = f.control.getMockImplementation()!
  f.control.mockImplementation(async (command) => {
    const result = await reply(command)
    if (command.action !== 'revoke' || result === undefined) return result
    f.terminate(result)
    return { ...result, ...patch }
  })
  await expect(f.detachHost()).rejects.toMatchObject({ errors: [failure] })
  expect(f.authority.list(request.sessionId)).toEqual([{
    ...request, status: 'revoked', terminal: true, epoch: request.epoch + 2,
  }])
  expect(f.control.mock.calls.map(([command]) => command.action)).not.toContain('remove')
})

it('refuses a Host replacement instead of rebinding the request to a new process', async () => {
  const f = fixture()
  f.prepare()
  const receipt = f.authority.prepare(f.owner, f.snapshot().id, f.lease)
  f.replaceHost()
  await expect(f.authority.requests.resume(f.owner, receipt)).rejects.toThrow('captured Host')
  expect(f.control).not.toHaveBeenCalled()
})
