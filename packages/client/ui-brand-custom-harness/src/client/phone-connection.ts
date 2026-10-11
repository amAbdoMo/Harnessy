/** Desktop-only, credential-free phone connection reads and clipboard outcomes. */
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'

/** Optional preload capability; pairing credentials never enter the renderer. */
export interface NativePhoneConnection {
  /** @returns Disabled state or the credential-free private HTTPS root, without userinfo, query, or fragment. */
  readonly describe: () => Promise<{ enabled: false } | { enabled: true; remoteRoot: string }>
  /** Copy the full operator-access link in the desktop process; rejects on failure and returns no link. */
  readonly copyPairingUrl: () => Promise<void>
}

/** Public description plus shared clipboard progress, retained across settings remounts. */
export type PhoneConnectionState =
  | { readonly status: 'loading' | 'unavailable' | 'disabled' }
  | { readonly status: 'enabled'; readonly remoteRoot: string; readonly copying: boolean }

/** Fixed clipboard outcome; IPC error text and pairing URLs are never retained. */
export interface PhoneConnectionNotice {
  readonly id: string
  readonly outcome: 'copied' | 'failed'
}

/** Owns phone settings and toast state for one plugin lifetime, not one settings panel. */
export class PhoneConnectionController {
  /** Latest credential-free description and clipboard progress. */
  readonly state = createSnapshotStore<PhoneConnectionState>({ status: 'loading' })
  /** Application-owned clipboard outcome, surviving settings-panel dismissal. */
  readonly notice = createSnapshotStore<PhoneConnectionNotice | undefined>(undefined)
  private readonly lifecycle = new AbortController()
  private description: Promise<void> | undefined

  /** @param native - Desktop preload methods that never return a pairing URL. */
  constructor(private readonly native: NativePhoneConnection) {}

  private isDisposed(): boolean {
    return this.lifecycle.signal.aborted
  }

  /**
   * Read readiness on startup or retry without retaining credentials or raw IPC errors; concurrent calls share one read.
   * @returns Completion after publishing a description or fixed error state, unless disposed.
   */
  describe(): Promise<void> {
    if (this.isDisposed()) return Promise.resolve()
    return this.description ??= this.readDescription().finally(() => { this.description = undefined })
  }

  private async readDescription(): Promise<void> {
    this.state.set({ status: 'loading' })
    let description: Awaited<ReturnType<NativePhoneConnection['describe']>>
    try {
      description = await this.native.describe()
    } catch (_error) {
      // IPC errors may contain credentials; retain only the fixed failure state.
      if (!this.isDisposed()) this.state.set({ status: 'unavailable' })
      return
    }
    if (this.isDisposed()) return
    this.state.set(description.enabled
      ? { status: 'enabled', remoteRoot: description.remoteRoot, copying: false }
      : { status: 'disabled' })
  }

  /**
   * Copy only when enabled, suppressing duplicate clicks and late notices after plugin disposal.
   * @returns completion after the desktop clipboard operation settles; failures publish a fixed notice.
   */
  async copy(): Promise<void> {
    const state = this.state.getSnapshot()
    if (this.isDisposed() || state.status !== 'enabled' || state.copying) return
    this.state.set({ ...state, copying: true })
    let outcome: PhoneConnectionNotice['outcome'] = 'copied'
    try {
      await this.native.copyPairingUrl()
    } catch (_error) {
      // The renderer must not expose raw clipboard or pairing errors.
      outcome = 'failed'
    }
    if (this.isDisposed()) return
    this.state.set({ ...state, copying: false })
    this.notice.set({ id: randomUUID(), outcome })
  }

  /**
   * Dismiss the current clipboard notice without clearing a newer outcome.
   * @param id - Notice whose display has completed.
   */
  dismiss(id: string): void {
    if (this.notice.getSnapshot()?.id === id) this.notice.set(undefined)
  }

  /** Suppress publication from unabortable desktop calls and clear the application-owned toast. */
  dispose(): void {
    this.lifecycle.abort()
    this.notice.set(undefined)
  }
}
