/** Main-owned phone pairing; process credentials never cross the product renderer bridge. */

import type { IpcMain, IpcMainInvokeEvent } from 'electron'
import { DESKTOP_IPC, type DesktopPhoneConnectionState } from './ipc.ts'
import type { DesktopHostReady } from './host-process.ts'

/**
 * Validate the credential-free optional root received from the Host process.
 * @param value - Untrusted ready-event field.
 * @returns Whether the value is a canonical private HTTPS root without URL credentials or parameters.
 */
export function isDesktopRemoteRoot(value: unknown): value is string {
  return typeof value === 'string' && !/\s/.test(value)
    && /^https:\/\/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.ts\.net\/$/.test(value)
}

/** One captured Host generation's private ready facts. */
interface Binding {
  readonly owner: object
  readonly ready?: DesktopHostReady
}

/** Private pairing state whose only credential-bearing output is an explicit clipboard write. */
export class DesktopPhoneConnection {
  #binding: Binding | undefined

  /**
   * @param currentHost - Current ready, non-stopping Host generation; absent during startup or teardown.
   * @param writeClipboard - Native writer whose promise settles after the clipboard write.
   */
  constructor(private readonly currentHost: () => object | undefined,
    private readonly writeClipboard: (text: string) => Promise<void>) {}

  /** @param owner - Newly allocated Host generation; withdraws any preceding pairing. */
  begin(owner: object): void { this.#binding = { owner } }

  /**
   * @param owner - Captured generation; retired generations cannot publish.
   * @param ready - Private readiness received after startup completes.
   */
  ready(owner: object, ready: DesktopHostReady): void {
    if (this.#binding?.owner === owner) this.#binding = { owner, ready }
  }

  /** @param owner - Generation whose failure or teardown withdraws pairing. */
  retire(owner: object): void {
    if (this.#binding?.owner === owner) this.#binding = undefined
  }

  /** @returns Credential-free settings state; disabled while the captured Host is unavailable. */
  describe(): DesktopPhoneConnectionState {
    const binding = this.#binding
    if (binding === undefined || binding.owner !== this.currentHost() || binding.ready?.remoteRoot === undefined) {
      return { enabled: false }
    }
    return { enabled: true, remoteRoot: binding.ready.remoteRoot }
  }

  /**
   * Copy an operator login URL from the captured Host token; no URL is returned or included in errors.
   * @returns Native write completion, rejected if pairing is withdrawn or the clipboard write fails.
   */
  async copyPairingUrl(): Promise<void> {
    const binding = this.#binding
    if (binding === undefined || binding.owner !== this.currentHost() || binding.ready?.remoteRoot === undefined) {
      throw new Error('Desktop phone connection is unavailable')
    }
    let local: URL
    try { local = new URL(binding.ready.url) }
    catch { throw new Error('Desktop phone connection has no valid Host credential') }
    const token = local.searchParams.get('token')
    if (local.protocol !== 'http:' || local.hostname !== '127.0.0.1' || local.username !== '' || local.password !== ''
      || local.pathname !== '/' || local.hash !== '' || token === null || token.length === 0) {
      throw new Error('Desktop phone connection has no valid Host credential')
    }
    const remote = new URL(binding.ready.remoteRoot)
    remote.searchParams.set('token', token)
    if (this.#binding !== binding || binding.owner !== this.currentHost()) {
      throw new Error('Desktop phone connection is unavailable')
    }
    try { await this.writeClipboard(remote.href) }
    catch { throw new Error('Desktop phone connection could not copy the pairing link') }
    if (this.#binding !== binding || binding.owner !== this.currentHost()) {
      throw new Error('Desktop phone connection is unavailable')
    }
  }
}

/**
 * Register primary-product-only IPC without accepting a renderer-selected destination.
 * @param ipc - Main-process IPC registry.
 * @param authorize - Checks the owned primary window and its top frame.
 * @param connection - Main-owned captured Host facts and clipboard capability.
 * @returns Disposer withdrawing both operations.
 */
export function installDesktopPhoneConnectionIpc(ipc: Pick<IpcMain, 'handle' | 'removeHandler'>,
  authorize: (event: IpcMainInvokeEvent) => void, connection: DesktopPhoneConnection): () => void {
  ipc.handle(DESKTOP_IPC.phoneConnectionDescribe, (event): DesktopPhoneConnectionState => {
    authorize(event)
    return connection.describe()
  })
  ipc.handle(DESKTOP_IPC.phoneConnectionCopyPairingUrl, (event): Promise<void> => {
    authorize(event)
    return connection.copyPairingUrl()
  })
  return () => {
    ipc.removeHandler(DESKTOP_IPC.phoneConnectionDescribe)
    ipc.removeHandler(DESKTOP_IPC.phoneConnectionCopyPairingUrl)
  }
}
