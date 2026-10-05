/** Untrusted Main-process result admission uses exact operation kind, UTF-8 JSON budgets and bounded PNG transport. */
import { expect, it } from 'vitest'
import type { DesktopWebsiteBrowserOperation } from '@deepseek-ai/dsh-client-ui-sidebar-browser/types'
import { isWebsiteBrowserResult } from '../src/website-browser-result.ts'
import { TINY_PNG } from './website-browser.fixture.ts'

const JSON_OPERATION: DesktopWebsiteBrowserOperation = { kind: 'evaluate', code: 'null' }
const SCREENSHOT: DesktopWebsiteBrowserOperation = { kind: 'screenshot', clip: { x: 0, y: 0, width: 1, height: 1 } }
const PNG_RESULT = { kind: 'screenshot', png: TINY_PNG, width: 1, height: 1 }

function nested(depth: number): unknown {
  let value: unknown = null
  for (let index = 0; index < depth; index++) value = [value]
  return value
}

it.each([
  ['null', null, true],
  ['mixed JSON', { values: [null, true, 1, 'visible'] }, true],
  ['exact 32 KiB serialized string', 'x'.repeat(32766), true],
  ['one byte over 32 KiB', 'x'.repeat(32767), false],
  ['exact UTF-8 budget', 'é'.repeat(16383), true],
  ['multibyte serialized overflow', 'é'.repeat(16384), false],
  ['escaped JSON overflow', '\n'.repeat(16384), false],
  ['oversized object key', { ['é'.repeat(16384)]: null }, false],
  ['depth eight', nested(8), true],
  ['depth nine', nested(9), false],
  ['1024 nodes including root', Array.from({ length: 1023 }, () => null), true],
  ['1025 nodes including root', Array.from({ length: 1024 }, () => null), false],
  ['nonfinite number', { value: Infinity }, false],
  ['undefined nested value', { value: undefined }, false],
] as const)('admits JSON only within all budgets: %s', (_name, value, admitted) => {
  expect(isWebsiteBrowserResult({ kind: 'json', value }, JSON_OPERATION)).toBe(admitted)
})

it.each([
  null,
  [],
  { kind: 'json' },
  { kind: 'json', value: null, extra: 'private' },
  { kind: 'dom-read', value: null },
  PNG_RESULT,
])('rejects wrong JSON result fields or kind: %j', (value) => {
  expect(isWebsiteBrowserResult(value, JSON_OPERATION)).toBe(false)
})

// Header-only transport probes do not create or persist a new raster.
function pngTransport(length: number, width = 1, height = 1): object {
  const bytes = Buffer.alloc(length)
  Buffer.from(TINY_PNG, 'base64').copy(bytes, 0, 0, Math.min(length, 24))
  if (length >= 24) { bytes.writeUInt32BE(width, 16); bytes.writeUInt32BE(height, 20) }
  return { kind: 'screenshot', png: bytes.toString('base64'), width, height }
}

it.each([
  ['static tiny PNG', PNG_RESULT, true],
  ['exact 1 MiB', pngTransport(1024 * 1024), true],
  ['one byte over 1 MiB', pngTransport(1024 * 1024 + 1), false],
  ['exact dimension ceilings', pngTransport(24, 2048, 2048), true],
  ['width above ceiling', pngTransport(24, 2049, 1), false],
  ['height above ceiling', pngTransport(24, 1, 2049), false],
  ['truncated header', pngTransport(23), false],
  ['zero width', { ...PNG_RESULT, width: 0 }, false],
  ['fractional height', { ...PNG_RESULT, height: 0.5 }, false],
  ['header dimension mismatch', { ...PNG_RESULT, width: 2 }, false],
  ['wrong kind', { ...PNG_RESULT, kind: 'json' }, false],
  ['extra field', { ...PNG_RESULT, value: 'private' }, false],
  ['missing field', { kind: 'screenshot', png: TINY_PNG, width: 1 }, false],
  ['JSON instead of image', { kind: 'json', value: null }, false],
  ['empty base64', { ...PNG_RESULT, png: '' }, false],
  ['noncanonical whitespace', { ...PNG_RESULT, png: TINY_PNG + '\n' }, false],
  ['invalid alphabet', { ...PNG_RESULT, png: '*' + TINY_PNG.slice(1) }, false],
  ['PNG signature mismatch', { ...PNG_RESULT, png: Buffer.from('not a PNG header with enough bytes').toString('base64') }, false],
] as const)('admits screenshot transport only with bounded exact fields: %s', (_name, value, admitted) => {
  expect(isWebsiteBrowserResult(value, SCREENSHOT)).toBe(admitted)
})

it.each(['IHDR', 'padding'] as const)('rejects a PNG transport with invalid %s bytes', (defect) => {
  const bytes = Buffer.alloc(25)
  Buffer.from(TINY_PNG, 'base64').copy(bytes, 0, 0, 24)
  if (defect === 'IHDR') bytes.write('IDAT', 12, 'ascii')
  const canonical = bytes.toString('base64')
  const png = defect === 'padding' ? canonical.slice(0, -3) + 'B==' : canonical
  expect(isWebsiteBrowserResult({ ...PNG_RESULT, png }, SCREENSHOT)).toBe(false)
})
