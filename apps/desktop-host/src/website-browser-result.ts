/** Admission of bounded native JSON and private PNG transport; raw screenshot data never becomes a tool result. */
import type { DesktopWebsiteBrowserJson, DesktopWebsiteBrowserOperation, DesktopWebsiteBrowserResult } from '@deepseek-ai/dsh-client-ui-sidebar-browser/types'

const PNG_BYTES = 1024 * 1024
const BASE64_BYTES = 4 * Math.ceil(PNG_BYTES / 3)
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function keys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  return Object.keys(value).length === expected.length && expected.every(key => Object.hasOwn(value, key))
}

function json(value: unknown, depth = 0, budget = { nodes: 0 }): value is DesktopWebsiteBrowserJson {
  if (++budget.nodes > 1024 || depth > 8) return false
  if (value === null || typeof value === 'boolean') return true
  if (typeof value === 'string') return Buffer.byteLength(value) <= 32 * 1024
  if (typeof value === 'number') return Number.isFinite(value)
  if (Array.isArray(value)) return value.length <= 1024 && value.every(item => json(item, depth + 1, budget))
  return record(value) && Object.keys(value).length <= 1024
    && Object.entries(value).every(([key, item]) => Buffer.byteLength(key) <= 32 * 1024 && json(item, depth + 1, budget))
}

/** @param value - untrusted native result. @param operation - captured operation, not response-provided kind.
 * @returns whether the result matches the operation and every private field is bounded.
 */
export function isWebsiteBrowserResult(value: unknown, operation: DesktopWebsiteBrowserOperation): value is DesktopWebsiteBrowserResult {
  if (!record(value)) return false
  if (operation.kind !== 'screenshot') {
    return keys(value, ['kind', 'value']) && value.kind === 'json' && json(value.value)
      && Buffer.byteLength(JSON.stringify(value.value)) <= 32 * 1024
  }
  if (!keys(value, ['kind', 'png', 'width', 'height']) || value.kind !== 'screenshot'
    || typeof value.png !== 'string' || value.png.length === 0 || value.png.length > BASE64_BYTES || !BASE64.test(value.png)
    || typeof value.width !== 'number' || !Number.isSafeInteger(value.width) || value.width < 1 || value.width > 2048
    || typeof value.height !== 'number' || !Number.isSafeInteger(value.height) || value.height < 1 || value.height > 2048) return false
  const bytes = Buffer.from(value.png, 'base64')
  return bytes.length >= 24 && bytes.length <= PNG_BYTES && bytes.toString('base64') === value.png
    && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    && bytes.toString('ascii', 12, 16) === 'IHDR' && bytes.readUInt32BE(16) === value.width && bytes.readUInt32BE(20) === value.height
}
