/** Validation of the private Desktop preview transport and trusted-renderer controls. */
import type {
  DevicePreviewBinding, DevicePreviewHostRequest, DevicePreviewOpenAcknowledgement, DevicePreviewOpenRequest,
  DevicePreviewId, DevicePreviewProjectId, DevicePreviewRequestId, DevicePreviewServerState,
} from '@deepseek-ai/dsh-client-ui-device-preview/types'
import type { DesktopBrowserLeaseId } from '@deepseek-ai/dsh-client-ui-sidebar-browser/types'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const CONTROL = /[\x00-\x1f\x7f]/

function record(input: unknown): input is Record<string, unknown> {
  return typeof input === 'object' && input !== null && !Array.isArray(input)
}
function uuid(input: unknown): input is string { return typeof input === 'string' && UUID.test(input) }
function text(input: unknown, maximum: number): input is string {
  return typeof input === 'string' && input.length > 0 && Buffer.byteLength(input, 'utf8') <= maximum && !CONTROL.test(input)
}
function only(input: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(input).every(key => keys.includes(key))
}
function address(input: unknown): input is string {
  if (!text(input, 4096)) return false
  try {
    const url = new URL(input)
    return (url.protocol === 'http:' || url.protocol === 'https:') && !url.username && !url.password
  } catch (error: unknown) { void error; return false }
}
function server(input: unknown): input is DevicePreviewServerState {
  if (!record(input) || !only(input, ['projectId', 'cwd', 'command', 'url', 'ownership', 'status', 'jobId', 'error'])
    || !(text(input.cwd, 4096) || (input.ownership === 'external' && input.cwd === '')) || !address(input.url)
    || (input.command !== undefined && !text(input.command, 16384))
    || (input.projectId !== undefined && !uuid(input.projectId))
    || (input.jobId !== undefined && !text(input.jobId, 200))
    || (input.error !== undefined && !text(input.error, 2048))) return false
  if (input.ownership === 'external') return input.status === 'external' && input.projectId === undefined && input.jobId === undefined
  return input.ownership === 'owned' && uuid(input.projectId)
    && ['starting', 'running', 'stopped', 'failed'].includes(String(input.status))
}

/** @param input - untrusted Host event. @returns whether the complete bounded preview request is valid. */
export function isDevicePreviewHostRequest(input: unknown): input is DevicePreviewHostRequest {
  if (!record(input) || !uuid(input.requestId)) return false
  if (input.type === 'device-preview-cancel') return only(input, ['type', 'requestId'])
  if (!uuid(input.previewId) || !text(input.sessionId, 4096)) return false
  if (input.type === 'device-preview-open') {
    return only(input, ['type', 'requestId', 'previewId', 'sessionId', 'server']) && server(input.server)
  }
  return input.type === 'device-preview-observe'
    && only(input, ['type', 'requestId', 'previewId', 'sessionId', 'slot', 'operation'])
    && (input.slot === 'phone' || input.slot === 'tablet')
    && (input.operation === 'screenshot' || input.operation === 'layout')
}

/** @param input - Main opening event crossing the preload. @returns validated explicit opening request, or throws. */
export function parseDevicePreviewOpenRequest(input: unknown): DevicePreviewOpenRequest {
  if (!isDevicePreviewHostRequest(input) || input.type !== 'device-preview-open') throw new Error('Device preview opening request rejected')
  return input
}

/** @param input - untrusted renderer acknowledgement. @returns exact opening acknowledgement, or throws. */
export function parseDevicePreviewAcknowledgement(input: unknown): DevicePreviewOpenAcknowledgement {
  if (!record(input) || !only(input, ['requestId', 'previewId', 'opened', 'error']) || !uuid(input.requestId)
    || !uuid(input.previewId) || typeof input.opened !== 'boolean'
    || (input.error !== undefined && !text(input.error, 2048))) throw new Error('Device preview acknowledgement rejected')
  return { requestId: input.requestId as DevicePreviewRequestId, previewId: input.previewId as DevicePreviewId,
    opened: input.opened, ...input.error === undefined ? {} : { error: input.error } }
}

/** @param input - untrusted renderer binding. @returns exact, bounded viewport and lease registration, or throws. */
export function parseDevicePreviewBinding(input: unknown): DevicePreviewBinding {
  if (!record(input) || !only(input, ['previewId', 'slot', 'lease', 'width', 'height', 'visible'])
    || !uuid(input.previewId) || (input.slot !== 'phone' && input.slot !== 'tablet') || !uuid(input.lease)
    || typeof input.width !== 'number' || !Number.isInteger(input.width) || input.width < 1 || input.width > 8192
    || typeof input.height !== 'number' || !Number.isInteger(input.height) || input.height < 1 || input.height > 8192
    || typeof input.visible !== 'boolean') throw new Error('Device preview frame registration rejected')
  return { previewId: input.previewId as DevicePreviewId, slot: input.slot, lease: input.lease as DesktopBrowserLeaseId,
    width: input.width, height: input.height, visible: input.visible }
}

/** @param input - untrusted renderer release. @returns exact guest registration to retire, or throws. */
export function parseDevicePreviewUnbinding(input: unknown): Pick<DevicePreviewBinding, 'previewId' | 'slot' | 'lease'> {
  if (!record(input) || !only(input, ['previewId', 'slot', 'lease']) || !uuid(input.previewId)
    || (input.slot !== 'phone' && input.slot !== 'tablet') || !uuid(input.lease)) throw new Error('Device preview frame release rejected')
  return { previewId: input.previewId as DevicePreviewId, slot: input.slot, lease: input.lease as DesktopBrowserLeaseId }
}

/** @param input - untrusted renderer preview selector. @returns validated opaque occurrence identity, or throws. */
export function parseDevicePreviewId(input: unknown): DevicePreviewId {
  if (!uuid(input)) throw new Error('Device preview occurrence identity rejected')
  return input as DevicePreviewId
}

/** @param input - untrusted renderer project selector. @returns validated opaque owned-launcher identity, or throws. */
export function parseDevicePreviewProjectId(input: unknown): DevicePreviewProjectId {
  if (!uuid(input)) throw new Error('Device preview launcher identity rejected')
  return input as DevicePreviewProjectId
}
