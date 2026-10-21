/** Exercise native badge rendering under Electron's V8 memory restrictions without opening a window. */
import { tsImport } from 'tsx/esm/api'

const { taskbarUnreadBitmap } = await tsImport('../src/taskbar-badge.ts', import.meta.url)
const masks = [1, 9, 10, 99, 100, Number.MAX_SAFE_INTEGER].map(taskbarUnreadBitmap)
if (masks.some(mask => mask.length !== 1024 || !mask.some(byte => byte > 0))) {
  throw new Error('Electron taskbar raster was empty or incorrectly sized')
}
if (new Set(masks.slice(0, 5).map(mask => mask.toString('hex'))).size !== 5 || !masks[4].equals(masks[5])) {
  throw new Error('Electron taskbar counts did not produce distinct and capped masks')
}
console.log('Electron taskbar raster passed')
