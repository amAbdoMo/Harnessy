/** Client-owned observation of the optional Desktop preload. */
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { DesktopUpdateBridge, DesktopUpdateView } from '../types.ts'
import { updateBusy } from './desktop-update-copy.ts'

/** Owns one preload subscription across every sidebar location and the General row. */
export class DesktopUpdateSource {
  /** Framework-observed carrier status shared by every update surface. */
  readonly store = createSnapshotStore<DesktopUpdateView>({ failed: false, busy: false })
  private live = true
  private received = false
  private readonly unsubscribe: (() => void) | undefined

  /** @param bridge - Optional isolated Electron API, absent in ordinary browsers. */
  constructor(private readonly bridge: DesktopUpdateBridge | undefined) {
    this.unsubscribe = bridge?.subscribe((presentation) => {
      if (!this.live) return
      this.received = true
      this.store.set({ ...this.store.getSnapshot(), presentation, failed: false })
    })
    void bridge?.status().then((presentation) => {
      if (this.live && !this.received) this.store.set({ ...this.store.getSnapshot(), presentation })
    }, () => {
      if (this.live && !this.received) this.store.set({ ...this.store.getSnapshot(), failed: true })
    })
  }

  /**
   * Run the shell's update flow: start a download, install a ready release, or
   * retry a failure. Requests join an operation already in flight.
   * @returns a promise settling when the shell answered or rejected the request.
   */
  open(): Promise<void> {
    return this.run(
      () => this.bridge?.open(),
      state => !updateBusy(state.presentation?.phase ?? 'idle'),
    )
  }

  /**
   * Ask the shell for an immediate check, regardless of its schedule.
   * @returns a promise settling when the shell answered or rejected the request.
   */
  check(): Promise<void> {
    return this.run(
      () => this.bridge?.check?.(),
      state => !updateBusy(state.presentation?.phase ?? 'idle'),
    )
  }

  /**
   * Cancel a staged restart that is waiting for running tasks.
   * @returns a promise settling when the shell answered or rejected the request.
   */
  cancelRestart(): Promise<void> {
    return this.run(() => this.bridge?.cancelRestart?.(), state => state.presentation?.phase === 'waiting')
  }

  /** Detach the carrier and ignore any pending status or action completion. */
  dispose(): void { this.live = false; this.unsubscribe?.() }

  /** Invoke one shell action unless the surface has no carrier or must not repeat it. */
  private run(action: () => Promise<void> | undefined, allowed: (state: DesktopUpdateView) => boolean): Promise<void> {
    if (!this.live) return Promise.resolve()
    const state = this.store.getSnapshot()
    if (state.busy || !allowed(state)) return Promise.resolve()
    const pending = action()
    if (pending === undefined) return Promise.resolve()
    this.store.set({ ...this.store.getSnapshot(), busy: true })
    return pending.catch(() => {
      if (this.live) this.store.set({ ...this.store.getSnapshot(), failed: true })
    }).finally(() => {
      if (this.live) this.store.set({ ...this.store.getSnapshot(), busy: false })
    })
  }
}
