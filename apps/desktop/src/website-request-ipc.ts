/** Renderer packets route to captured website requests; no packet can create a Host/Agent owner. */
import type { IpcMain, IpcMainInvokeEvent } from 'electron'
import type {
  DesktopBrowserLeaseId, DesktopWebsiteHostSnapshot, DesktopWebsiteRequestId,
  DesktopWebsiteRequestPreparation, DesktopWebsiteRequestReceipt, DesktopWebsiteVisibilityId,
} from '@deepseek-ai/dsh-client-ui-sidebar-browser/types'
import type { DesktopWebsiteAuthority } from './website-authority.ts'
import { DESKTOP_IPC } from './ipc.ts'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

function uuid(value: unknown): string {
  if (typeof value !== 'string' || !UUID.test(value)) throw new Error('Invalid website request identifier')
  return value
}

function fields(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Invalid website request packet')
  const candidate = value as Record<string, unknown>
  if (Object.keys(candidate).some(key => !keys.includes(key))) throw new Error('Unsupported website request fields')
  return candidate
}

/** @param value - untrusted renderer Session identity. @returns bounded routing identity; it confers no Agent authority. */
export function parseWebsiteRequestSession(value: unknown): DesktopWebsiteHostSnapshot['sessionId'] {
  if (typeof value !== 'string' || value.length === 0 || Buffer.byteLength(value) > 4096 || /[\x00-\x1f\x7f]/.test(value)) {
    throw new Error('Invalid website request Session')
  }
  return value as DesktopWebsiteHostSnapshot['sessionId']
}

/** @param value - untrusted renderer association. @returns only exact supported Session, request and native lease fields. */
export function parseWebsiteRequestPreparation(value: unknown): DesktopWebsiteRequestPreparation {
  const candidate = fields(value, ['requestId', 'sessionId', 'lease'])
  return { requestId: uuid(candidate.requestId) as DesktopWebsiteRequestId,
    sessionId: parseWebsiteRequestSession(candidate.sessionId), lease: uuid(candidate.lease) as DesktopBrowserLeaseId }
}

/**
 * @param value - untrusted renderer receipt.
 * @returns bounded native generation/visibility/lease fields; the coordinator checks current ownership.
 */
export function parseWebsiteRequestReceipt(value: unknown): DesktopWebsiteRequestReceipt {
  const candidate = fields(value, ['requestId', 'epoch', 'visibility', 'lease'])
  if (typeof candidate.epoch !== 'number' || !Number.isSafeInteger(candidate.epoch) || candidate.epoch < 0) {
    throw new Error('Invalid website request generation')
  }
  return { requestId: uuid(candidate.requestId) as DesktopWebsiteRequestId, epoch: candidate.epoch,
    visibility: uuid(candidate.visibility) as DesktopWebsiteVisibilityId, lease: uuid(candidate.lease) as DesktopBrowserLeaseId }
}

/**
 * @param ipc - native handler owner.
 * @param authorize - exact primary renderer/main-frame/origin authentication; invoked before packet parsing or side effects.
 * @param authority - process-local captured Host/native request coordinator.
 * @returns disposer of every installed handler; registration failure rolls back prior handlers.
 */
export function installWebsiteRequestIpc(ipc: Pick<IpcMain, 'handle' | 'removeHandler'>,
  authorize: (event: IpcMainInvokeEvent) => void,
  authority: Pick<DesktopWebsiteAuthority, 'list' | 'assertSession' | 'prepare' | 'requests'>): () => void {
  const registered: string[] = []
  const dispose = (): void => { for (const channel of registered.splice(0)) ipc.removeHandler(channel) }
  const handle = (channel: string, callback: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown): void => {
    ipc.handle(channel, (event, ...args: unknown[]) => { authorize(event); return callback(event, ...args) })
    registered.push(channel)
  }
  try {
    handle(DESKTOP_IPC.websiteRequestsList, (_event, session) => authority.list(parseWebsiteRequestSession(session)))
    handle(DESKTOP_IPC.websiteRequestsPrepare, (event, value) => {
      const input = parseWebsiteRequestPreparation(value)
      authority.assertSession(input.requestId, input.sessionId)
      return authority.prepare(event.sender, input.requestId, input.lease)
    })
    handle(DESKTOP_IPC.websiteRequestsVisible, (event, requestId, visible) => {
      if (typeof visible !== 'boolean') throw new Error('Website request visibility must be boolean')
      return authority.requests.setVisible(event.sender, uuid(requestId) as DesktopWebsiteRequestId, visible)
    })
    handle(DESKTOP_IPC.websiteRequestsAcknowledge, (event, value) => {
      authority.requests.acknowledge(event.sender, parseWebsiteRequestReceipt(value))
    })
    handle(DESKTOP_IPC.websiteRequestsResume, (event, value) => authority.requests.resume(event.sender, parseWebsiteRequestReceipt(value)))
    handle(DESKTOP_IPC.websiteRequestsTakeover, (event, value) => {
      const id = uuid(value) as DesktopWebsiteRequestId
      authority.requests.setVisible(event.sender, id, false)
      return authority.requests.revoke(id)
    })
  } catch (error) { dispose(); throw error }
  return dispose
}
