/** User-authorized downloads and separate installation of one version-bound Desktop release. */

import { existsSync } from 'node:fs'
import { statfs } from 'node:fs/promises'
import { join } from 'node:path'
import { app } from 'electron'
import electronUpdater, { type AppUpdater, type ProgressInfo, type UpdateInfo } from 'electron-updater'
import { gt, prerelease, valid } from 'semver'
import type { DesktopUpdateState } from './ipc.ts'
import { DesktopUpdateHttpExecutor } from './update-http-executor.ts'
import { DesktopUpdatePreparationError } from './update-error.ts'

const { autoUpdater } = electronUpdater

/** Owns one updater target until its download and installation settle. */
export class DesktopUpdateCoordinator {
  private current: DesktopUpdateState = { phase: 'idle' }
  private candidate: string | undefined
  private candidateIdentity: string | undefined
  private candidateBytes: number | undefined
  private downloaded = false
  private stableOnly = true
  private disposed = false
  private checkOperation: Promise<DesktopUpdateState> | undefined
  private downloadOperation: Promise<DesktopUpdateState> | undefined
  private installOperation: Promise<DesktopUpdateState> | undefined

  private readonly onProgress = (progress: ProgressInfo): void => {
    if (this.downloadOperation === undefined || this.downloaded) return
    const percent = Math.min(100, Math.max(0, progress.percent))
    this.setState({
      phase: percent >= 100 ? 'verifying' : 'downloading',
      ...this.target(),
      percent,
      transferredBytes: progress.transferred,
      totalBytes: progress.total,
    })
  }

  private readonly onDownloaded = (info: UpdateInfo): void => {
    if (this.downloadOperation === undefined || info.version !== this.candidate) return
    this.downloaded = true
  }

  private readonly onError = (error: Error): void => {
    // Check/download promises own their failures. Installation can fail after quitAndInstall returns.
    if (this.current.phase === 'installing') {
      this.setState(this.failure(error, 'install'))
    }
  }

  /**
   * @param publish - Receives observable states for every Desktop window.
   * @param beforeRestart - Completes task authorization, admission locking, and owned-process shutdown.
   * @param updater - Process-owned Electron updater, replaceable at the network/platform test boundary.
   * @param enabled - Whether this process has a packaged update source.
   * @param currentVersion - Actual installed application version.
   * @param freeBytes - Available bytes on the updater cache volume.
   */
  constructor(
    private readonly publish: (state: DesktopUpdateState) => DesktopUpdateState,
    private readonly beforeRestart: (version: string) => Promise<boolean>,
    private readonly updater: AppUpdater = autoUpdater,
    private readonly enabled: () => boolean = () => app.isPackaged && existsSync(join(process.resourcesPath, 'app-update.yml')),
    private readonly currentVersion: () => string = () => app.getVersion(),
    private readonly freeBytes: () => Promise<number> = async () => {
      const stats = await statfs(app.getPath('userData'))
      return stats.bavail * stats.bsize
    },
  ) {
    if (updater === autoUpdater) {
      // electron-updater omits this internal transport property from its public declarations.
      // Real-Electron qualification exercises the pinned dependency integration.
      const transportOwner = updater as AppUpdater & { httpExecutor: DesktopUpdateHttpExecutor }
      transportOwner.httpExecutor = new DesktopUpdateHttpExecutor(
        Number(process.env.DSH_DESKTOP_UPDATE_HTTP_IDLE_TIMEOUT_MS ?? 60_000),
        (authInfo, callback) => { updater.emit('login', authInfo, callback) },
      )
    }
    this.updater.autoDownload = false
    this.updater.autoInstallOnAppQuit = false
    this.updater.allowPrerelease = true
    // Selecting a channel can enable downgrade in electron-updater.
    this.updater.allowDowngrade = false
    this.updater.on('download-progress', this.onProgress)
    this.updater.on('update-downloaded', this.onDownloaded)
    this.updater.on('error', this.onError)
  }

  /** Latest observable state; complete download identity remains main-process-owned. */
  get state(): DesktopUpdateState { return this.current }

  /**
   * Select stable production filtering after the packaged manifest is loaded.
   * @param stableOnly - True for the public production feed; false for isolated qualification feeds.
   */
  setStableOnly(stableOnly: boolean): void { this.stableOnly = stableOnly }

  /** Publish or cancel the non-persistent restart-when-idle state selected by native UI. */
  setWaiting(waiting: boolean): DesktopUpdateState {
    this.assertLive()
    if (!this.downloaded || this.candidate === undefined) throw new Error('desktop update: no prepared update can wait')
    return this.setState({ phase: waiting ? 'waiting' : 'ready', version: this.candidate })
  }

  /**
   * Check metadata without downloading, joining any current check.
   * @param manual - Whether a failed check must remain visible in the status indicator.
   * @returns The check result, including a silent automatic failure when applicable.
   */
  async check(manual = false): Promise<DesktopUpdateState> {
    this.assertLive()
    if (this.downloadOperation !== undefined || this.installOperation !== undefined) return this.current
    if (this.downloaded && !(this.current.phase === 'error' && this.current.failedOperation === 'verify')) return this.current
    if (this.current.phase === 'error' && this.current.failedOperation === 'verify') this.downloaded = false
    this.checkOperation ??= Promise.resolve().then(() => this.doCheck())
      .finally(() => { this.checkOperation = undefined })
    const result = await this.checkOperation
    if (manual && result.phase === 'error') this.setState(result)
    if (result.phase === 'available' && result.version !== undefined) return this.download(result.version)
    return result
  }

  /**
   * @param version - Version shown in the user's download confirmation.
   * @returns Download readiness or failure, without authorizing installation.
   */
  async download(version: string): Promise<DesktopUpdateState> {
    this.assertLive()
    if (this.candidate !== undefined && version !== this.candidate) throw new Error('desktop update: download confirmation is stale')
    if (this.downloaded || this.installOperation !== undefined) return this.current
    this.downloadOperation ??= Promise.resolve().then(async () => {
      await this.checkOperation
      this.assertLive()
      if (this.candidate === undefined) throw new Error('desktop update: no checked update is available')
      if (version !== this.candidate) throw new Error('desktop update: download confirmation is stale')
      try {
        if (this.candidateBytes !== undefined) {
          const required = this.candidateBytes * 2 + 128 * 1024 * 1024
          if (await this.freeBytes() < required) {
            throw new Error(`desktop update: insufficient disk space; ${String(required)} bytes required`)
          }
        }
        this.setState({ phase: 'downloading', version, percent: 0 })
        await this.updater.downloadUpdate()
        if (!this.downloaded) throw new Error('desktop update: platform preparation did not report readiness')
        return this.setState({ phase: 'ready', version })
      } catch (error) {
        this.downloaded = false
        return this.setState(this.failure(error, 'download'))
      }
    }).finally(() => { this.downloadOperation = undefined })
    return this.downloadOperation
  }

  /**
   * Revalidate the prepared release after task admission is locked.
   * @param version - Exact version admitted for installation.
   * @returns the ready state, or the newer/withdrawn state that prevents handoff.
   */
  async verify(version: string): Promise<DesktopUpdateState> {
    this.assertLive()
    if (!this.downloaded || version !== this.candidate) throw new Error('desktop update: admitted target is not ready')
    await this.revalidate(version)
    return this.current
  }

  /**
   * Install a prepared target after a separate user confirmation.
   * @param version - Exact version displayed in the confirmation, never a renderer-selected URL.
   * @returns Installation handoff or a recoverable preparation error.
   */
  async install(version: string): Promise<DesktopUpdateState> {
    this.assertLive()
    if (!this.downloaded || this.downloadOperation !== undefined || version !== this.candidate) throw new Error('desktop update: confirmed target is not ready')
    this.installOperation ??= Promise.resolve().then(async () => {
      try {
        if (!await this.revalidate(version)) return this.current
        this.setState({ phase: 'installing', version })
        if (!await this.beforeRestart(version)) return this.setState({ phase: 'ready', version })
        this.assertLive()
        this.updater.quitAndInstall(true, true)
        return this.current
      } catch (error) {
        if (this.current.phase === 'available'
          || this.current.phase === 'error' && (this.current.failedOperation === 'verify' || this.current.failedOperation === 'install')) {
          return this.current
        }
        return this.setState(this.failure(error, 'install'))
      }
    }).finally(() => {
      this.installOperation = undefined
      if (this.current.phase === 'available' && this.current.version !== undefined && !this.disposed) {
        void this.download(this.current.version)
      }
    })
    return this.installOperation
  }

  /** Remove owned listeners and prevent pending library operations from publishing into closed UI. */
  dispose(): void {
    this.disposed = true
    this.updater.off('download-progress', this.onProgress)
    this.updater.off('update-downloaded', this.onDownloaded)
    // Pending updater promises can still emit EventEmitter errors during shutdown.
    void Promise.allSettled([this.checkOperation, this.downloadOperation, this.installOperation])
      .then(() => { this.updater.off('error', this.onError) })
  }

  private assertLive(): void {
    if (this.disposed) throw new Error('desktop update: coordinator is disposed')
  }

  private setState(state: DesktopUpdateState): DesktopUpdateState {
    if (!this.disposed) {
      this.current = state
      this.publish(state)
    }
    return state
  }

  private failure(error: unknown, failedOperation: 'check' | 'download' | 'verify' | 'install'): DesktopUpdateState {
    return { phase: 'error', ...this.target(), failedOperation,
      message: error instanceof Error ? error.message : String(error),
      ...(error instanceof DesktopUpdatePreparationError ? {
        preparationFailure: error.kind,
        ...(error.technicalDetails === undefined ? {} : { technicalDetails: error.technicalDetails }),
      } : {}) }
  }

  private target(): { version?: string } {
    return this.candidate === undefined ? {} : { version: this.candidate }
  }

  private updateIdentity(info: UpdateInfo): string {
    return JSON.stringify(info.files.map(file => ({ url: file.url, sha512: file.sha512, size: file.size ?? null })))
  }

  /** Confirm the prepared artifact remains the latest published stable release before stopping work. */
  private async revalidate(version: string): Promise<boolean> {
    this.setState({ phase: 'checking', version })
    let result: Awaited<ReturnType<AppUpdater['checkForUpdates']>>
    try {
      // The prepared bytes were hash-verified at download, so a feed re-check
      // that cannot reach the network (rate limit, outage) must not block the
      // confirmed installation; the next startup re-checks normally.
      result = await this.updater.checkForUpdates()
    } catch (error: unknown) {
      console.warn('desktop update: release re-check is unreachable; installing the verified artifact', error)
      return true
    }
    try {
      if (result === null) throw new Error('desktop update: no check result was returned')
      const latest = result.updateInfo.version
      if (valid(latest) === null || this.stableOnly && prerelease(latest) !== null) {
        throw new Error('desktop update: feed version is not applicable')
      }
      if (!result.isUpdateAvailable || !gt(latest, this.currentVersion())) {
        throw new Error('desktop update: release was withdrawn')
      }
      if (latest !== version) {
        this.downloaded = false
        this.candidate = latest
        this.candidateIdentity = this.updateIdentity(result.updateInfo)
        this.candidateBytes = result.updateInfo.files[0]?.size
        this.setState({ phase: 'available', version: latest })
        return false
      }
      if (this.updateIdentity(result.updateInfo) !== this.candidateIdentity) {
        throw new Error('desktop update: release was superseded')
      }
      return true
    } catch (error) {
      this.setState(this.failure(error, 'verify'))
      return false
    }
  }

  private async doCheck(): Promise<DesktopUpdateState> {
    try {
      this.assertLive()
      if (!this.enabled()) throw new Error('desktop update: this application has no packaged update source')
      const result = await this.updater.checkForUpdates()
      if (result === null) throw new Error('desktop update: no check result was returned')
      const version = result.updateInfo.version
      if (valid(version) === null || this.stableOnly && prerelease(version) !== null) {
        throw new Error('desktop update: feed version is not applicable')
      }
      this.candidate = result.isUpdateAvailable && gt(version, this.currentVersion()) ? version : undefined
      this.candidateIdentity = this.candidate === undefined ? undefined : this.updateIdentity(result.updateInfo)
      this.candidateBytes = this.candidate === undefined ? undefined : result.updateInfo.files[0]?.size
      return this.setState(this.candidate === undefined ? { phase: 'idle' } : { phase: 'available', version })
    } catch (error) {
      return this.failure(error, 'check')
    }
  }
}
