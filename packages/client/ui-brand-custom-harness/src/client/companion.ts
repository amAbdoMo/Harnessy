/** Public native companion status and dialog progress owned by one client plugin lifetime. */
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'

/** Native status fields; pairing identities and credentials are never renderer data. */
export interface NativeCompanionStatus {
  readonly available: boolean
  readonly connected: boolean
  readonly pairedCount: number
}

/** Optional preload capability; Main owns all pairing and device-management decisions. */
export interface NativeCompanion {
  /** @returns Public availability, connection state, and paired-device count; rejects on read failure. */
  readonly describe: () => Promise<NativeCompanionStatus>
  /** @returns Completion of native management dialogs, not confirmation of a pairing change; rejects on failure. */
  readonly open: () => Promise<void>
}

/** Retained public status, exclusive request progress, and classified errors without native text. */
export interface CompanionState {
  readonly status?: NativeCompanionStatus | undefined
  readonly busy?: 'refresh' | 'open'
  readonly error?: 'read' | 'open'
}

/**
 * Serializes native requests across settings remounts; disposal silences unabortable calls.
 * While busy, either action shares the existing request without starting another operation.
 */
export class CompanionController {
  /** Immutable snapshots retain the last successful status when a request fails. */
  readonly state = createSnapshotStore<CompanionState>(Object.freeze({}))
  private readonly lifecycle = new AbortController()
  private flight: Promise<void> | undefined

  /** @param native - Status-only reads and Main-owned management dialogs. */
  constructor(private readonly native: NativeCompanion) {}

  /**
   * Refresh status without opening native windows or exposing private responses.
   * @returns Settlement of the shared request; read errors publish a fixed inline error classification.
   */
  describe(): Promise<void> {
    return this.request('refresh')
  }

  /**
   * Leave pairing decisions in Main and refresh actual status after its dialogs settle.
   * @returns Dialog completion followed by a fresh status read; failures publish classified inline errors.
   */
  open(): Promise<void> {
    return this.request('open')
  }

  private request(operation: 'refresh' | 'open'): Promise<void> {
    if (this.lifecycle.signal.aborted) return Promise.resolve()
    if (this.flight !== undefined) return this.flight
    this.publish({ status: this.state.getSnapshot().status, busy: operation })
    return this.flight = this.run(operation).finally(() => { this.flight = undefined })
  }

  private async run(operation: 'refresh' | 'open'): Promise<void> {
    if (operation === 'open') {
      try {
        await this.native.open()
      } catch (_error) {
        // Native failures may contain private pairing details; retain only the operation classification.
        this.publish({ status: this.state.getSnapshot().status, error: 'open' })
        return
      }
    }
    if (this.lifecycle.signal.aborted) return
    await this.readStatus()
  }

  private async readStatus(): Promise<void> {
    let status: NativeCompanionStatus
    try {
      status = await this.native.describe()
    } catch (_error) {
      // A failed read does not mean that the release has disabled companion access.
      this.publish({ status: this.state.getSnapshot().status, error: 'read' })
      return
    }
    this.publish({ status: Object.freeze({
      available: status.available, connected: status.connected, pairedCount: status.pairedCount,
    }) })
  }

  private publish(snapshot: CompanionState): void {
    if (!this.lifecycle.signal.aborted) this.state.set(Object.freeze(snapshot))
  }

  /** Drop late native results and prevent new requests; native dialog cancellation belongs to Main. */
  dispose(): void {
    this.lifecycle.abort()
  }
}
