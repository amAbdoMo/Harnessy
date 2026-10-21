import { describe, expect, it } from 'vitest'
import { resizeFromKey, resizeFromPointer, resizeOrigin, type ResizeDirection } from '../src/client/device-resize.ts'

const directions: { direction: ResizeDirection; width: number; height: number; left: number; top: number }[] = [
  { direction: 'n', width: 400, height: 770, left: 0, top: 30 },
  { direction: 'ne', width: 420, height: 770, left: 0, top: 30 },
  { direction: 'e', width: 420, height: 800, left: 0, top: 0 },
  { direction: 'se', width: 420, height: 830, left: 0, top: 0 },
  { direction: 's', width: 400, height: 830, left: 0, top: 0 },
  { direction: 'sw', width: 380, height: 830, left: 20, top: 0 },
  { direction: 'w', width: 380, height: 800, left: 20, top: 0 },
  { direction: 'nw', width: 380, height: 770, left: 20, top: 30 },
]

describe.each([0.5, 1, 0.625])('CSS viewport resize at display scale %s', (scale) => {
  it.each(directions)('$direction moves only its axes and preserves the opposite anchor', ({ direction, width, height, left, top }) => {
    const start = { width: 400, height: 800 }
    const resized = resizeFromPointer(start, direction, { x: 20 * scale, y: 30 * scale }, scale)
    expect(resized).toEqual({ width, height })
    expect(resizeOrigin(start, resized, direction, scale)).toEqual({ left: left * scale, top: top * scale })
  })
})

it('rounds CSS dimensions once and clamps the complete result on both axes', () => {
  expect(resizeFromPointer({ width: 400, height: 800 }, 'se', { x: 1, y: -1 }, 0.625)).toEqual({ width: 402, height: 798 })
  expect(resizeFromPointer({ width: 400, height: 800 }, 'se', { x: 10000, y: -10000 }, 0.5)).toEqual({ width: 2560, height: 240 })
  const start = { width: 400, height: 800 }
  const minimum = resizeFromPointer(start, 'nw', { x: 10000, y: 10000 }, 0.5)
  expect(minimum).toEqual({ width: 240, height: 240 })
  expect(resizeOrigin(start, minimum, 'nw', 0.5)).toEqual({ left: 80, top: 280 })
  expect(resizeFromPointer(start, 'nw', { x: -10000, y: -10000 }, 0.5)).toEqual({ width: 2560, height: 2560 })
})

it.each([
  { direction: 'e', key: 'ArrowRight', shiftKey: false, width: 401, height: 800 },
  { direction: 'w', key: 'ArrowLeft', shiftKey: true, width: 410, height: 800 },
  { direction: 'n', key: 'ArrowUp', shiftKey: false, width: 400, height: 801 },
  { direction: 's', key: 'ArrowDown', shiftKey: true, width: 400, height: 810 },
  { direction: 'ne', key: 'ArrowDown', shiftKey: false, width: 400, height: 799 },
  { direction: 'sw', key: 'ArrowRight', shiftKey: true, width: 390, height: 800 },
] satisfies { direction: ResizeDirection; key: string; shiftKey: boolean; width: number; height: number }[])('keyboard $key moves $direction in CSS pixels', ({ direction, key, shiftKey, width, height }) => {
  expect(resizeFromKey({ width: 400, height: 800 }, direction, { key, shiftKey })).toEqual({ width, height })
})

it('ignores unrelated keyboard axes and keys, and bounds keyboard increments', () => {
  expect(resizeFromKey({ width: 400, height: 800 }, 'n', { key: 'ArrowRight', shiftKey: false })).toBeUndefined()
  expect(resizeFromKey({ width: 400, height: 800 }, 'se', { key: 'Enter', shiftKey: false })).toBeUndefined()
  expect(resizeFromKey({ width: 2560, height: 240 }, 'se', { key: 'ArrowRight', shiftKey: true })).toEqual({ width: 2560, height: 240 })
  expect(resizeFromKey({ width: 2560, height: 240 }, 'se', { key: 'ArrowUp', shiftKey: true })).toEqual({ width: 2560, height: 240 })
})
