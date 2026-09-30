import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AppUpdater } from 'electron-updater'
import { DESKTOP_HOST_PROTOCOL_VERSION } from '../src/host-protocol.ts'
import { parseDesktopRelease } from '../src/release.ts'
import type { DesktopUpdateState } from '../src/ipc.ts'
import { DesktopUpdatePreparationError } from '../src/update-error.ts'
import { zh } from '../src/locale.ts'

vi.mock('electron', () => ({ app: { isPackaged: false } }))
vi.mock('electron-updater', () => ({
  default: {
    autoUpdater: { autoDownload: true, autoInstallOnAppQuit: true },
    NsisUpdater: EventEmitter,
  },
}))

const { DesktopUpdateCoordinator } = await import('../src/update-coordinator.ts')

describe('desktop release metadata', () => {
  it('accepts one exact release identity for Electron and dsh', () => {
    expect(parseDesktopRelease({
      schemaVersion: 1,
      version: '1.2.3',
      hostProtocolVersion: DESKTOP_HOST_PROTOCOL_VERSION,
      nodeVersion: '24.17.0',
      pnpmVersion: '11.7.0',
    })).toEqual({
      schemaVersion: 1,
      version: '1.2.3',
      hostProtocolVersion: DESKTOP_HOST_PROTOCOL_VERSION,
      nodeVersion: '24.17.0',
      pnpmVersion: '11.7.0',
    })
  })

  it('rejects invalid versions and unsupported host protocols', () => {
    const base = {
      schemaVersion: 1,
      version: '1.2.3',
      hostProtocolVersion: DESKTOP_HOST_PROTOCOL_VERSION,
      nodeVersion: '24.17.0',
      pnpmVersion: '11.7.0',
    }
    expect(() => parseDesktopRelease({ ...base, version: 'latest' })).toThrow(/invalid desktop release metadata/u)
    expect(() => parseDesktopRelease({ ...base, hostProtocolVersion: 999 })).toThrow(/invalid desktop release metadata/u)
  })
})

const releaseFiles = [{ url: 'Harnessy-Setup-1.1.0-win-x64.exe', sha512: 'hash', size: 100 }]
const coordinators: InstanceType<typeof DesktopUpdateCoordinator>[] = []
afterEach(() => { for (const item of coordinators.splice(0)) item.dispose() })

function fixture() {
  const events = new EventEmitter()
  const checkForUpdates = vi.fn(async () => ({
    isUpdateAvailable: true,
    updateInfo: { version: '1.1.0', files: releaseFiles },
  }))
  const downloadUpdate = vi.fn(async () => {
    events.emit('download-progress', { percent: 58 })
    events.emit('download-progress', { percent: 100 })
    events.emit('update-downloaded', { version: '1.1.0' })
    return ['verified-package']
  })
  const quitAndInstall = vi.fn()
  const beforeRestart = vi.fn(async () => true)
  const states: DesktopUpdateState[] = []
  const updater = Object.assign(events, { checkForUpdates, downloadUpdate, quitAndInstall }) as unknown as AppUpdater
  const coordinator = new DesktopUpdateCoordinator(
    (state) => { states.push(state); return state },
    beforeRestart, updater, () => true, () => '1.0.0', async () => Number.MAX_SAFE_INTEGER,
  )
  coordinators.push(coordinator)
  return { coordinator, updater, events, states, checkForUpdates, downloadUpdate, quitAndInstall, beforeRestart }
}

describe('desktop update coordinator', () => {
  it('keeps safe preparation diagnostics separate and clears them on an explicit retry', async () => {
    const f = fixture()
    await f.coordinator.check()
    await f.coordinator.download('1.1.0')
    f.beforeRestart.mockRejectedValueOnce(new DesktopUpdatePreparationError('stop-failed', zh.updateStopFailed, 'exit 0; shutdown acknowledged false'))
    expect(await f.coordinator.install('1.1.0')).toEqual({ phase: 'error', version: '1.1.0',
      failedOperation: 'install', preparationFailure: 'stop-failed', message: zh.updateStopFailed,
      technicalDetails: 'exit 0; shutdown acknowledged false' })
    expect(f.quitAndInstall).not.toHaveBeenCalled()
    f.beforeRestart.mockResolvedValueOnce(false)
    expect(await f.coordinator.install('1.1.0')).toEqual({ phase: 'ready', version: '1.1.0' })
    expect(f.quitAndInstall).not.toHaveBeenCalled()
  })

  it('retains an asynchronous installer failure after quitAndInstall returns', async () => {
    const f = fixture()
    await f.coordinator.check()
    await f.coordinator.download('1.1.0')
    await f.coordinator.install('1.1.0')
    f.events.emit('error', new Error('installer could not start'))
    expect(f.coordinator.state).toMatchObject({ phase: 'error', failedOperation: 'install', message: 'installer could not start' })
  })

  it('waits for platform preparation after its downloaded event and rejects stale download approval', async () => {
    const f = fixture()
    const prepared = Promise.withResolvers<string[]>()
    f.downloadUpdate.mockImplementationOnce(async () => {
      f.events.emit('update-downloaded', { version: '1.1.0' })
      return prepared.promise
    })
    const downloading = f.coordinator.check()
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    try {
      await expect(f.coordinator.download('1.1.0-rc.1')).rejects.toThrow(/stale/u)
      expect(f.coordinator.state.phase).not.toBe('ready')
      await expect(f.coordinator.install('1.1.0')).rejects.toThrow(/not ready/u)
    } finally { prepared.resolve(['verified']); await downloading }
    expect(f.coordinator.state.phase).toBe('ready')
  })

  it('consumes late updater errors until an in-flight check settles after disposal', async () => {
    const f = fixture()
    const checked = Promise.withResolvers<{ isUpdateAvailable: boolean; updateInfo: { version: string; files: typeof releaseFiles } }>()
    f.checkForUpdates.mockImplementation(() => checked.promise)
    const pending = f.coordinator.check()
    await Promise.resolve()
    f.coordinator.dispose()
    expect(() => f.events.emit('error', new Error('late network failure'))).not.toThrow()
    checked.reject(new Error('offline'))
    await pending
    await Promise.resolve()
    expect(f.events.listenerCount('error')).toBe(0)
  })

  it('checks and downloads automatically, then requires separate installation approval', async () => {
    const f = fixture()
    await f.coordinator.check()
    expect(f.downloadUpdate).toHaveBeenCalledOnce()
    expect(f.quitAndInstall).not.toHaveBeenCalled()
    expect(f.beforeRestart).not.toHaveBeenCalled()
    expect(f.coordinator.state).toEqual({ phase: 'ready', version: '1.1.0' })
    await f.coordinator.install('1.1.0')
    expect(f.beforeRestart).toHaveBeenCalledOnce()
    expect(f.quitAndInstall).toHaveBeenCalledWith(true, true)
    expect(f.states.map(state => state.phase)).toEqual([
      'available', 'downloading', 'downloading', 'verifying', 'ready', 'checking', 'ready', 'installing',
    ])
    expect(f.updater).toMatchObject({
      autoDownload: false, autoInstallOnAppQuit: false,
      allowPrerelease: true, allowDowngrade: false,
    })
  })

  it('joins checks and downloads without retargeting a prepared release', async () => {
    const f = fixture()
    const checked = Promise.withResolvers<{ isUpdateAvailable: boolean; updateInfo: { version: string; files: typeof releaseFiles } }>()
    f.checkForUpdates.mockImplementation(() => checked.promise)
    const checking = f.coordinator.check()
    const manual = f.coordinator.check(true)
    const firstDownload = f.coordinator.download('1.1.0')
    const secondDownload = f.coordinator.download('1.1.0')
    checked.resolve({ isUpdateAvailable: true, updateInfo: { version: '1.1.0', files: releaseFiles } })
    await Promise.all([checking, manual, firstDownload, secondDownload])
    expect(f.checkForUpdates).toHaveBeenCalledOnce()
    expect(f.downloadUpdate).toHaveBeenCalledOnce()
    await f.coordinator.check(true)
    expect(f.checkForUpdates).toHaveBeenCalledOnce()
    await expect(f.coordinator.install('1.2.0')).rejects.toThrow(/not ready/u)
  })

  it('keeps automatic failures silent and exposes a manual caller joining the same check', async () => {
    const f = fixture()
    f.checkForUpdates.mockRejectedValue(new Error('offline'))
    expect(await f.coordinator.check()).toMatchObject({ phase: 'error', failedOperation: 'check' })
    expect(f.states).toEqual([])
    await Promise.all([f.coordinator.check(), f.coordinator.check(true)])
    expect(f.states).toEqual([expect.objectContaining({ phase: 'error', failedOperation: 'check' })])
    expect(f.downloadUpdate).not.toHaveBeenCalled()
  })

  it.each(['1.0.0', '1.1.0-alpha.1', 'invalid'])('does not download or install inapplicable version %s', async (version) => {
    const f = fixture()
    f.checkForUpdates.mockResolvedValue({ isUpdateAvailable: true, updateInfo: { version, files: releaseFiles } })
    await f.coordinator.check()
    await expect(f.coordinator.download('1.1.0')).rejects.toThrow(/no checked update/u)
    expect(f.downloadUpdate).not.toHaveBeenCalled()
  })

  it('accepts prerelease versions only for an isolated qualification feed', async () => {
    const f = fixture()
    f.coordinator.setStableOnly(false)
    f.checkForUpdates.mockResolvedValue({ isUpdateAvailable: true, updateInfo: {
      version: '1.1.0-nightly.1', files: [{ url: 'Harnessy.exe', sha512: 'nightly', size: 1024 }],
    } })
    f.downloadUpdate.mockImplementationOnce(async () => {
      f.events.emit('update-downloaded', { version: '1.1.0-nightly.1' })
      return ['verified']
    })
    expect(await f.coordinator.check()).toEqual({ phase: 'ready', version: '1.1.0-nightly.1' })
  })

  it('rejects an automatic download before transfer when the cache volume lacks space', async () => {
    const f = fixture()
    const coordinator = new DesktopUpdateCoordinator(
      state => state,
      async () => true,
      f.updater,
      () => true,
      () => '1.0.0',
      async () => 1,
    )
    coordinators.push(coordinator)
    expect(await coordinator.check()).toMatchObject({ phase: 'error', failedOperation: 'download' })
    expect(f.downloadUpdate).not.toHaveBeenCalled()
  })

  it('retains retry state after download failure and never equates 100 percent with readiness', async () => {
    const f = fixture()
    f.downloadUpdate.mockImplementationOnce(async () => {
      f.events.emit('download-progress', { percent: 100 })
      throw new Error('signature rejected')
    })
    expect(await f.coordinator.check()).toMatchObject({ phase: 'error', failedOperation: 'download' })
    await expect(f.coordinator.install('1.1.0')).rejects.toThrow(/not ready/u)
    await f.coordinator.check(true)
    expect(f.coordinator.state.phase).toBe('ready')
    expect(f.quitAndInstall).not.toHaveBeenCalled()
  })

  it('refuses a withdrawn release when it is revalidated before restart', async () => {
    const f = fixture()
    await f.coordinator.check()
    f.checkForUpdates.mockResolvedValueOnce({ isUpdateAvailable: false, updateInfo: { version: '1.0.0', files: releaseFiles } })
    expect(await f.coordinator.install('1.1.0')).toMatchObject({ phase: 'error', failedOperation: 'verify' })
    expect(f.beforeRestart).not.toHaveBeenCalled()
    expect(f.quitAndInstall).not.toHaveBeenCalled()
    expect(await f.coordinator.check(true)).toMatchObject({ phase: 'ready', version: '1.1.0' })
    expect(f.downloadUpdate).toHaveBeenCalledTimes(2)
  })

  it('restores ready after an identical final release check', async () => {
    const f = fixture()
    await f.coordinator.check()
    expect(await f.coordinator.verify('1.1.0')).toEqual({ phase: 'ready', version: '1.1.0' })
  })

  it('installs the hash-verified artifact when the revalidation check cannot reach the feed', async () => {
    const f = fixture()
    await f.coordinator.check()
    await f.coordinator.download('1.1.0')
    f.checkForUpdates.mockRejectedValueOnce(new Error('GitHub API rate limit exceeded'))
    expect(await f.coordinator.verify('1.1.0')).toEqual({ phase: 'ready', version: '1.1.0' })
    f.checkForUpdates.mockRejectedValueOnce(new Error('GitHub API rate limit exceeded'))
    expect(await f.coordinator.install('1.1.0')).toMatchObject({ phase: 'installing', version: '1.1.0' })
    expect(f.beforeRestart).toHaveBeenCalledOnce()
    expect(f.quitAndInstall).toHaveBeenCalledWith(true, true)
  })

  it('refuses handoff after failed task preparation while retaining the prepared package', async () => {
    const f = fixture()
    f.beforeRestart.mockRejectedValueOnce(new Error('tasks could not stop'))
    await f.coordinator.check()
    await f.coordinator.download('1.1.0')
    expect(await f.coordinator.install('1.1.0')).toMatchObject({ phase: 'error', failedOperation: 'install' })
    expect(f.quitAndInstall).not.toHaveBeenCalled()
    await f.coordinator.install('1.1.0')
    expect(f.downloadUpdate).toHaveBeenCalledOnce()
    expect(f.quitAndInstall).toHaveBeenCalledOnce()
  })

  it('does not publish late check completion after disposal', async () => {
    const f = fixture()
    const checked = Promise.withResolvers<{ isUpdateAvailable: boolean; updateInfo: { version: string; files: typeof releaseFiles } }>()
    f.checkForUpdates.mockImplementation(() => checked.promise)
    const pending = f.coordinator.check()
    f.coordinator.dispose()
    checked.resolve({ isUpdateAvailable: true, updateInfo: { version: '1.1.0', files: releaseFiles } })
    await pending
    expect(f.states).toEqual([])
    expect(f.events.listenerCount('download-progress')).toBe(0)
  })
})
