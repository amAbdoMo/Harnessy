/** GDI allocation and call failures are exercised at the Koffi boundary, without opening native windows. */
import { afterEach, expect, it, vi } from 'vitest'
import { taskbarUnreadBitmap } from '../src/taskbar-badge.ts'

const gdi = await vi.hoisted(async () => (await import('./gdi-mock.ts')).createGdiMock())
vi.mock('koffi', () => ({ default: gdi.koffi }))
afterEach(() => { vi.clearAllMocks() })

it.each([
  ['CreateCompatibleDC', null], ['CreateDIBSection', null], ['CreatePen', null], ['CreateFontW', null],
  ['GetStockObject', null], ['Ellipse', 0], ['SetTextColor', 0xffffffff], ['SetBkMode', 0],
  ['DrawTextW', 0], ['GdiFlush', 0],
])('releases every acquired GDI handle after %s fails', (operation, failure) => {
  gdi.calls[operation]!.mockReturnValueOnce(failure)
  expect(() => taskbarUnreadBitmap(23)).toThrow(operation)
  expect(gdi.owned.size).toBe(0)
  expect(taskbarUnreadBitmap(23).byteLength).toBe(16 * 16 * 4)
  expect(gdi.owned.size).toBe(0)
})

it.each([0, 1, 2, 3])('releases all selected resources when SelectObject call %s fails', (selection) => {
  const select = gdi.calls.SelectObject!
  const implementation = select.getMockImplementation()
  if (implementation === undefined) throw new Error('Missing selection implementation')
  for (let call = 0; call < selection; call++) select.mockImplementationOnce(implementation)
  select.mockReturnValueOnce(null)
  expect(() => taskbarUnreadBitmap(23)).toThrow('SelectObject')
  expect(gdi.owned.size).toBe(0)
})

it('releases every owned handle even when a Koffi drawing call throws', () => {
  const failure = new Error('FFI unavailable')
  gdi.calls.DrawTextW!.mockImplementationOnce(() => { throw failure })
  expect(() => taskbarUnreadBitmap(100)).toThrow(failure)
  expect(gdi.owned.size).toBe(0)
})

it.each(['DeleteDC', 'DeleteObject'])('attempts remaining cleanup and reports a %s failure', (operation) => {
  const remove = gdi.calls[operation]!
  const implementation = remove.getMockImplementation()
  if (implementation === undefined) throw new Error('Missing deletion implementation')
  // Simulate a failing return after freeing so the test fixture itself cannot leak handles.
  remove.mockImplementationOnce((...args: never[]) => { implementation(...args); return 0 })
  expect(() => taskbarUnreadBitmap(100)).toThrow('GDI cleanup failed')
  expect(gdi.calls.DeleteObject).toHaveBeenCalledTimes(3)
  expect(gdi.owned.size).toBe(0)
})
