/** Real GDI raster smoke stays in memory and never creates a window, notification or image file. */
import koffi from 'koffi'
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { taskbarUnreadBitmap } from '../src/taskbar-badge.ts'

const require = createRequire(import.meta.url)
const electronInstalled = existsSync(join(dirname(require.resolve('electron')), 'path.txt'))

// Node-only native tests cannot detect Electron's restrictions on external ArrayBuffers.
it.skipIf(process.platform !== 'win32' || !electronInstalled)('renders unread counts under Electron without a native crash', { timeout: 30_000 }, () => {
  const executable: unknown = require('electron')
  if (typeof executable !== 'string') throw new Error('Electron executable is unavailable')
  const child = spawnSync(executable, [fileURLToPath(new URL('./taskbar-badge-electron.fixture.mjs', import.meta.url))], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8', timeout: 20_000, windowsHide: true,
  })
  expect(child.error).toBeUndefined()
  expect(child.signal).toBeNull()
  expect(child.status, child.stderr).toBe(0)
  expect(child.stdout.trim()).toBe('Electron taskbar raster passed')
})

// gdi32/user32 DLLs and Segoe UI are Windows-owned requirements of this rasterizer.
it.skipIf(process.platform !== 'win32')('renders distinct white numbered rings and releases real GDI resources', () => {
  const masks = [1, 9, 10, 99, 100, Number.MAX_SAFE_INTEGER].map(taskbarUnreadBitmap)
  for (const mask of masks) {
    expect(mask.byteLength).toBe(16 * 16 * 4)
    expect([...mask.subarray(0, 4)]).toEqual([0, 0, 0, 0])
    expect([...mask.subarray(-4)]).toEqual([0, 0, 0, 0])
    const alpha: number[] = []
    for (let offset = 0; offset < mask.length; offset += 4) {
      expect([...mask.subarray(offset, offset + 3)]).toEqual(Array<number>(3).fill(mask[offset + 3]!))
      alpha.push(mask[offset + 3]!)
    }
    expect(Math.max(...alpha)).toBeGreaterThan(240)
    expect(alpha.some(coverage => coverage > 0 && coverage < 255)).toBe(true)
    expect(mask[(1 * 16 + 7) * 4 + 3]).toBeGreaterThan(0)
    const center = alpha.filter((_, index) => index % 16 >= 4 && index % 16 <= 11
      && Math.floor(index / 16) >= 4 && Math.floor(index / 16) <= 11)
    expect(center.some(coverage => coverage > 0)).toBe(true)
    expect(center.some(coverage => coverage === 0)).toBe(true)
  }
  expect(new Set(masks.slice(0, 5).map(mask => mask.toString('hex'))).size).toBe(5)
  expect(masks[4]).toEqual(masks[5])
  const kernel = koffi.load('kernel32.dll')
  const user = koffi.load('user32.dll')
  const currentProcess = kernel.func('void * __stdcall GetCurrentProcess()')
  const resources = user.func('uint32 __stdcall GetGuiResources(void *process, uint32 flags)')
  const processHandle: unknown = currentProcess()
  const before: unknown = resources(processHandle, 0)
  for (let count = 1; count <= 100; count++) taskbarUnreadBitmap(count)
  expect(resources(processHandle, 0)).toBe(before)
})
