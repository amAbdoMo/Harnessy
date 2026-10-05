/** Account operations serialize cleanup, drain IPC, and publish only safe settled feedback. */
import { describe, expect, it, vi } from 'vitest'
import { createWebsiteProfilesModel } from '../src/client/browser/profiles.ts'
import type { DesktopWebsiteProfile, DesktopWebsiteProfileId, DesktopWebsiteProfilesBridge } from '../src/types.ts'

const id = '11111111-2222-4333-8444-555555555555' as DesktopWebsiteProfileId
const profile: DesktopWebsiteProfile = { id, name: 'Portal', accountLabel: 'Operations',
  url: 'https://portal.example.test/', mcpServerName: 'portal', control: 'human' }

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((settle) => { resolve = settle })
  return { promise, resolve }
}

function bridge(): DesktopWebsiteProfilesBridge {
  return { list: vi.fn(async () => [profile]), create: vi.fn(async () => profile),
    acquire: vi.fn(), setControl: vi.fn(async () => {}), signOut: vi.fn(async () => {}),
    forget: vi.fn(async () => {}), onChanged: vi.fn(() => () => {}) }
}

describe('website profile operations', () => {
  it.each(['create', 'takeover', 'signOut', 'forget'] as const)('keeps failed %s feedback free of Main-process diagnostics and retryable', async (action) => {
    const api = bridge()
    const error = new Error('private account token')
    if (action === 'create') vi.mocked(api.create).mockRejectedValueOnce(error)
    else if (action === 'takeover') vi.mocked(api.setControl).mockRejectedValueOnce(error)
    else vi.mocked(api[action]).mockRejectedValueOnce(error)
    const model = createWebsiteProfilesModel(api)
    try {
      await model.commands.reload()
      const invoke = () => action === 'create' ? model.commands.create(profile) : model.commands[action](id)
      await invoke()
      expect(model.source.getSnapshot()).toMatchObject({
        profiles: [profile], busy: undefined, creating: false, notice: { kind: 'failed' },
      })
      expect(model.source.getSnapshot().notice).not.toHaveProperty('message')
      expect(JSON.stringify(model.source.getSnapshot())).not.toContain(error.message)
      await invoke()
      expect(model.source.getSnapshot().notice?.kind).not.toBe('failed')
    } finally {
      await model.dispose()
    }
  })

  it('revokes account reservations without clearing login and refreshes the Main-projected status', async () => {
    const api = bridge()
    const model = createWebsiteProfilesModel(api)
    try {
      await model.commands.reload()
      await model.commands.takeover(id)
      expect(api.setControl).toHaveBeenCalledExactlyOnceWith(id, 'human')
      expect(api.signOut).not.toHaveBeenCalled()
      expect(api.forget).not.toHaveBeenCalled()
      expect(model.source.getSnapshot()).toMatchObject({ profiles: [profile], busy: undefined, notice: { kind: 'human' } })
    } finally { await model.dispose() }
  })

  it('serializes account cleanup without changing profile-wide Agent control', async () => {
    const api = bridge()
    const entered = Promise.withResolvers<undefined>()
    const clearing = Promise.withResolvers<undefined>()
    vi.mocked(api.signOut).mockImplementation(async () => { entered.resolve(undefined); await clearing.promise })
    const model = createWebsiteProfilesModel(api)
    try {
      const signingOut = model.commands.signOut(id)
      await entered.promise
      const forgetting = model.commands.forget(id)
      expect(api.forget).not.toHaveBeenCalled()
      clearing.resolve(undefined)
      await Promise.all([signingOut, forgetting])
      expect(api.forget).toHaveBeenCalledExactlyOnceWith(id)
      expect(api.setControl).not.toHaveBeenCalled()
      expect(model.source.getSnapshot().notice?.kind).toBe('forgotten')
    } finally {
      clearing.resolve(undefined)
      await model.dispose()
    }
  })

  it('announces request outcomes without changing profile-wide control or publishing after disposal', async () => {
    const api = bridge()
    const model = createWebsiteProfilesModel(api)
    try {
      await model.commands.reload()
      model.reportRequest(id, 'resumed')
      expect(model.source.getSnapshot().notice).toMatchObject({ kind: 'resumed', name: 'Portal' })
      model.reportRequest(id, 'human')
      expect(model.source.getSnapshot().notice).toMatchObject({ kind: 'human', name: 'Portal' })
      expect(api.setControl).not.toHaveBeenCalled()
      await model.dispose()
      model.reportRequest(id, 'requestFailed')
      expect(model.source.getSnapshot().notice?.kind).toBe('human')
    } finally {
      await model.dispose()
    }
  })

  it.each(['settled', 'failed'] as const)('joins the refresh after a %s mutation without publishing or starting queued work after disposal', async (outcome) => {
    const api = bridge()
    const model = createWebsiteProfilesModel(api)
    const refresh = deferred<readonly DesktopWebsiteProfile[]>()
    try {
      await model.commands.reload()
      vi.mocked(api.list).mockReturnValueOnce(refresh.promise)
      if (outcome === 'failed') vi.mocked(api.create).mockRejectedValueOnce(new Error('private mutation diagnostic'))
      const creating = model.commands.create(profile)
      await vi.waitFor(() => { expect(api.list).toHaveBeenCalledTimes(3) })
      const forgetting = model.commands.forget(id)
      const snapshot = model.source.getSnapshot()
      let drained = false
      const disposing = model.dispose().then(() => { drained = true })
      await Promise.resolve()
      expect(drained).toBe(false)
      refresh.resolve([{ ...profile, name: 'Late profile' }])
      expect(await creating).toBeUndefined()
      await Promise.all([forgetting, disposing])
      expect(drained).toBe(true)
      expect(model.source.getSnapshot()).toBe(snapshot)
      expect(api.forget).not.toHaveBeenCalled()
      expect(api.list).toHaveBeenCalledTimes(3)
    } finally {
      refresh.resolve([])
      await model.dispose()
    }
  })

  it('awaits in-flight IPC, suppresses late publication, and never invokes queued IPC after disposal', async () => {
    const api = bridge()
    const entered = Promise.withResolvers<undefined>()
    const creating = deferred<DesktopWebsiteProfile>()
    const unsubscribe = vi.fn()
    vi.mocked(api.onChanged).mockReturnValue(unsubscribe)
    vi.mocked(api.create).mockImplementation(async () => { entered.resolve(undefined); return creating.promise })
    const model = createWebsiteProfilesModel(api)
    try {
      const create = model.commands.create(profile)
      await entered.promise
      const signingOut = model.commands.signOut(id)
      const snapshot = model.source.getSnapshot()
      let drained = false
      const disposing = model.dispose().then(() => { drained = true })
      await Promise.resolve()
      expect(drained).toBe(false)
      expect(unsubscribe).toHaveBeenCalledOnce()
      creating.resolve(profile)
      expect(await create).toBeUndefined()
      await Promise.all([signingOut, disposing])
      expect(api.setControl).not.toHaveBeenCalled()
      expect(model.source.getSnapshot()).toBe(snapshot)
      await model.commands.reload()
      await model.commands.forget(id)
      expect(api.signOut).not.toHaveBeenCalled()
      expect(api.forget).not.toHaveBeenCalled()
    } finally {
      creating.resolve(profile)
      await model.dispose()
    }
  })
})
