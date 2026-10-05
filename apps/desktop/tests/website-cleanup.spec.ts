/** Saved-alias cleanup with real profile persistence and native request admission. */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { WebContents } from 'electron'
import type { DesktopBrowserLeaseId, DesktopWebsiteProfile } from '@deepseek-ai/dsh-client-ui-sidebar-browser/types'
import { expect, it, onTestFinished, vi } from 'vitest'
import { DesktopHostProcess } from '../src/host-process.ts'
import { DesktopWebsiteProfiles, type DesktopWebsitePairing } from '../src/website-profiles.ts'
import { DesktopWebsiteRequests, type DesktopWebsiteRequestId, type DesktopWebsiteRequestInput } from '../src/website-requests.ts'

const BLOCKED = 'Website profile data must be cleared successfully before it can be used'
const activeInput = { name: 'Portal', accountLabel: 'operator', url: 'https://portal.example.test/', mcpServerName: 'portal' }
const activeBinding = { identity: 'a'.repeat(64), endpoint: 'https://api.example.test/mcp' }
const separateBinding = { identity: 'b'.repeat(64), endpoint: 'https://other.example.test/mcp' }
const dimensions = ['origin', 'namespace', 'binding', 'endpoint'] as const
const actions = ['signOut', 'forget'] as const

async function fixture(dimension: typeof dimensions[number]) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-website-cleanup-'))
  const filename = join(root, 'profiles.json')
  const physical: PromiseWithResolvers<void> = Promise.withResolvers()
  const enteredPhysical: PromiseWithResolvers<void> = Promise.withResolvers()
  const remote: PromiseWithResolvers<void> = Promise.withResolvers()
  const enteredRemote: PromiseWithResolvers<void> = Promise.withResolvers()
  const storage: PromiseWithResolvers<void> = Promise.withResolvers()
  const enteredStorage: PromiseWithResolvers<void> = Promise.withResolvers()
  const pending: Promise<unknown>[] = []
  onTestFinished(async () => {
    physical.resolve(); remote.resolve(); storage.resolve()
    await Promise.allSettled(pending)
    await rm(root, { recursive: true, force: true })
  })
  const aliasInput = { ...activeInput, name: 'Alias', url: 'https://alias.example.test/', mcpServerName: 'alias' }
  const aliasBinding = { ...separateBinding }
  switch (dimension) {
    case 'origin': aliasInput.url = 'https://portal.example.test/admin'; break
    case 'namespace': aliasInput.mcpServerName = activeInput.mcpServerName; break
    case 'binding': aliasBinding.identity = activeBinding.identity; break
    case 'endpoint': aliasBinding.endpoint = activeBinding.endpoint; break
  }
  const pairing: DesktopWebsitePairing = {
    inspect: async namespace => namespace === activeInput.mcpServerName ? activeBinding
      : namespace === aliasInput.mcpServerName ? aliasBinding : namespace === 'secondary' ? separateBinding
        : { identity: 'c'.repeat(64), endpoint: 'https://separate.example.test/mcp' },
    confirm: async () => {}, enroll: async () => {},
  }
  // Electron and the private Host transport are external; account identity and persistence remain real.
  const owner = { isDestroyed: () => false } as WebContents
  const guest = { isDestroyed: () => false } as WebContents
  const host = new DesktopHostProcess('node', 'unused-runtime', 'unused-project')
  const clearStorage = vi.fn(async () => { enteredStorage.resolve(); await storage.promise })
  const profiles: DesktopWebsiteProfiles = new DesktopWebsiteProfiles(
    filename, clearStorage, pairing, account => requests.revokeAccount(account),
  )
  const nativeProfiles = new Map<DesktopBrowserLeaseId, DesktopWebsiteProfile['id']>()
  const drain = vi.fn(async (_input: DesktopWebsiteRequestInput) => { enteredRemote.resolve(); await remote.promise })
  const requests: DesktopWebsiteRequests = new DesktopWebsiteRequests({
    currentHost: () => host,
    assertProfile: (input) => { profiles.assertAvailable(input.profile) },
    inspectGuest: (_owner, lease) => {
      const profile = nativeProfiles.get(lease)
      return profile === undefined ? undefined : { owner, guest, profile, attached: true, releasing: false,
        ownerAuthenticated: true, windowVisible: true, windowMinimized: false }
    },
    validate: async () => {}, commit: async () => {}, revoke: () => {}, drain,
  })
  const active = await profiles.create(activeInput)
  const alias = await profiles.create(aliasInput)
  const unrelated = await profiles.create({ ...activeInput, name: 'Separate', url: 'https://separate.example.test/', mcpServerName: 'separate' })
  await profiles.setControl(active.id, 'agent')
  function input(profile: DesktopWebsiteProfile): DesktopWebsiteRequestInput {
    const lease = `lease-${profile.id}` as DesktopBrowserLeaseId
    nativeProfiles.set(lease, profile.id)
    return { requestId: `request-${profile.id}` as DesktopWebsiteRequestId, host, agentId: 'agent', sessionId: 'session',
      profile: profile.id, url: profile.url, mcpServerName: profile.mcpServerName, mcpBinding: profiles.binding(profile.id), owner, lease }
  }
  const id = requests.prepare(input(active))
  const receipt = requests.setVisible(owner, id, true)!
  requests.acknowledge(owner, receipt)
  const grant = await requests.resume(owner, receipt)
  let signal: AbortSignal | undefined
  const operation = requests.run(host, grant.requestId, new AbortController().signal, async (_guest, admittedSignal) => {
    signal = admittedSignal; enteredPhysical.resolve(); await physical.promise
    return 'private result'
  })
  const observedOperation = operation.then(value => value, (error: unknown) => error)
  pending.push(observedOperation)
  await enteredPhysical.promise
  return { filename, pairing, profiles, requests, active, alias, unrelated, input, clearStorage, physical, remote, storage,
    enteredRemote, enteredStorage, pending, observedOperation, owner, host, drain, signal: () => signal }
}

it.each(actions.flatMap(action => dimensions.map(dimension => [action, dimension] as const)))(
  '%s fences an unprepared saved %s alias through physical work, Host drainage and storage cleanup', async (action, dimension) => {
    const f = await fixture(dimension)
    const cleanup = f.profiles[action](f.alias.id)
    f.pending.push(cleanup)
    // These checks occur in the same turn as SignOut/Forget, before metadata I/O or Host acknowledgement.
    expect(f.signal()?.aborted).toBe(true)
    expect(() => f.profiles.assertAvailable(f.active.id)).toThrow(BLOCKED)
    expect(() => f.profiles.assertAgent(f.active.id)).toThrow(BLOCKED)
    expect(() => f.requests.prepare(f.input(f.active))).toThrow(BLOCKED)
    expect(f.profiles.assertAvailable(f.unrelated.id).id).toBe(f.unrelated.id)
    await expect(f.profiles.acquire(f.active.id)).rejects.toThrow(BLOCKED)
    await expect(f.profiles.setControl(f.active.id, 'agent')).rejects.toThrow(BLOCKED)
    expect(f.clearStorage).not.toHaveBeenCalled()

    f.physical.resolve()
    await f.enteredRemote.promise
    expect(await f.observedOperation).toBeInstanceOf(Error)
    expect(f.clearStorage).not.toHaveBeenCalled()
    expect(() => f.profiles.assertAvailable(f.active.id)).toThrow(BLOCKED)
    f.remote.resolve()
    await f.enteredStorage.promise
    expect(() => f.profiles.assertAvailable(f.active.id)).toThrow(BLOCKED)
    const persisted = JSON.parse(await readFile(f.filename, 'utf8')) as { profiles: (DesktopWebsiteProfile & { cleanupPending: boolean })[] }
    expect(persisted.profiles.find(profile => profile.id === f.alias.id))
      .toMatchObject({ cleanupPending: true })
    f.storage.resolve()
    await cleanup
    expect(f.profiles.assertAvailable(f.active.id).id).toBe(f.active.id)
    if (action === 'forget') expect((await f.profiles.list()).map(profile => profile.id)).not.toContain(f.alias.id)
    else expect(f.profiles.assertAvailable(f.alias.id).control).toBe('human')
  },
)

it.each(actions)('%s retains the saved alias fence after failed Host drainage, including retry and restart', async (action) => {
  const f = await fixture('origin')
  const cleanup = f.profiles[action](f.alias.id)
  const rejected = expect(cleanup).rejects.toThrow('Website authority drainage failed')
  f.pending.push(cleanup, rejected)
  f.physical.resolve()
  await f.enteredRemote.promise
  f.remote.reject(new Error('Host settlement unknown'))
  await rejected
  expect(f.clearStorage).not.toHaveBeenCalled()
  expect((await f.profiles.list()).find(profile => profile.id === f.alias.id)?.control).toBe('cleanup-failed')
  expect(() => f.profiles.assertAvailable(f.active.id)).toThrow(BLOCKED)
  await expect(f.profiles[action](f.alias.id)).rejects.toThrow('Website authority drainage failed')
  expect(f.clearStorage).not.toHaveBeenCalled()

  // A fresh process has no live transaction; persisted cleanup still blocks aliases until storage clears.
  const restartedClear = vi.fn(async () => {})
  const restarted = new DesktopWebsiteProfiles(f.filename, restartedClear, f.pairing, async () => {})
  await restarted.list()
  expect(() => restarted.assertAvailable(f.active.id)).toThrow(BLOCKED)
  await expect(restarted.acquire(f.active.id)).rejects.toThrow(BLOCKED)
  await restarted[action](f.alias.id)
  expect(restartedClear).toHaveBeenCalledOnce()
  expect(restarted.assertAvailable(f.active.id).id).toBe(f.active.id)
})

it.each(actions)('%s joins a held sibling after another account request fails drainage', async (action) => {
  const f = await fixture('origin')
  const secondary = await f.profiles.create({ ...activeInput, name: 'Secondary', url: 'https://secondary.example.test/', mcpServerName: 'secondary' })
  const id = f.requests.prepare(f.input(secondary))
  const receipt = f.requests.setVisible(f.owner, id, true)!
  f.requests.acknowledge(f.owner, receipt)
  await f.requests.resume(f.owner, receipt)
  const failed: PromiseWithResolvers<void> = Promise.withResolvers()
  const held: PromiseWithResolvers<void> = Promise.withResolvers()
  f.drain.mockImplementation(async (input) => {
    if (input.profile === f.active.id) { failed.resolve(); throw new Error('One request failed') }
    held.resolve(); await f.remote.promise
  })
  const cleanup = f.profiles[action](f.alias.id)
  const rejected = expect(cleanup).rejects.toThrow('Website authority drainage failed')
  f.pending.push(cleanup, rejected)
  let finished = false
  void cleanup.then(() => { finished = true }, () => { finished = true })
  f.physical.resolve()
  await Promise.all([failed.promise, held.promise, f.observedOperation])
  expect(finished).toBe(false)
  expect(f.clearStorage).not.toHaveBeenCalled()
  expect(() => f.profiles.assertAvailable(secondary.id)).toThrow(BLOCKED)
  f.remote.resolve()
  await rejected
  expect(f.clearStorage).not.toHaveBeenCalled()
  expect((await f.profiles.list()).find(profile => profile.id === f.alias.id)?.control).toBe('cleanup-failed')
})

it.each(actions)('%s joins physical and Host drainage even when pending metadata cannot be written', async (action) => {
  const f = await fixture('origin')
  const before = await readFile(f.filename, 'utf8')
  await rm(f.filename)
  await mkdir(f.filename)
  const cleanup = f.profiles[action](f.alias.id)
  const rejected = expect(cleanup).rejects.toThrow(/EISDIR|EPERM|EACCES|EEXIST/)
  f.pending.push(cleanup, rejected)
  let finished = false
  void cleanup.then(() => { finished = true }, () => { finished = true })
  f.physical.resolve()
  await f.enteredRemote.promise
  expect(finished).toBe(false)
  expect(f.clearStorage).not.toHaveBeenCalled()
  expect(() => f.profiles.assertAvailable(f.active.id)).toThrow(BLOCKED)
  f.remote.resolve()
  await rejected
  expect(f.clearStorage).not.toHaveBeenCalled()
  expect(() => f.profiles.assertAvailable(f.active.id)).toThrow(BLOCKED)
  await rm(f.filename, { recursive: true })
  await writeFile(f.filename, before)
  f.storage.resolve()
  await f.profiles[action](f.alias.id)
  expect(f.profiles.assertAvailable(f.active.id).id).toBe(f.active.id)
})

it.each(actions)('%s permits storage cleanup retry without releasing its saved alias fence early', async (action) => {
  const f = await fixture('origin')
  const cleanup = f.profiles[action](f.alias.id)
  const rejected = expect(cleanup).rejects.toThrow('Storage unavailable')
  f.pending.push(cleanup, rejected)
  f.physical.resolve(); f.remote.resolve()
  await f.enteredStorage.promise
  f.storage.reject(new Error('Storage unavailable'))
  await rejected
  expect(() => f.profiles.assertAvailable(f.active.id)).toThrow(BLOCKED)
  f.clearStorage.mockImplementationOnce(async () => {})
  await f.profiles[action](f.alias.id)
  expect(f.profiles.assertAvailable(f.active.id).id).toBe(f.active.id)
})
