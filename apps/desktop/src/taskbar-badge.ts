/** In-memory Windows GDI mask rendering; no windows, files or browser documents are created. */
import koffi from 'koffi'

const SCALE = 4
const SIZE = 16
const RASTER_SIZE = SIZE * SCALE

function loadGdi() {
  const gdi = koffi.load('gdi32.dll')
  const user = koffi.load('user32.dll')
  const bitmapInfo = koffi.struct({
    size: 'uint32', width: 'int32', height: 'int32', planes: 'uint16', bitCount: 'uint16',
    compression: 'uint32', sizeImage: 'uint32', xPixels: 'int32', yPixels: 'int32',
    colorsUsed: 'uint32', colorsImportant: 'uint32', color: 'uint32',
  })
  const rect = koffi.struct({ left: 'int32', top: 'int32', right: 'int32', bottom: 'int32' })
  return {
    pixelBytes: koffi.array('uint8', RASTER_SIZE * RASTER_SIZE * 4, 'Typed'),
    createDC: gdi.func('void * __stdcall CreateCompatibleDC(void *dc)'),
    deleteDC: gdi.func('int __stdcall DeleteDC(void *dc)'),
    createBitmap: gdi.func('__stdcall', 'CreateDIBSection', 'void *', ['void *', koffi.pointer(bitmapInfo), 'uint32', koffi.out(koffi.pointer('void *')), 'void *', 'uint32']),
    deleteObject: gdi.func('int __stdcall DeleteObject(void *object)'),
    selectObject: gdi.func('void * __stdcall SelectObject(void *dc, void *object)'),
    stockObject: gdi.func('void * __stdcall GetStockObject(int index)'),
    createPen: gdi.func('void * __stdcall CreatePen(int style, int width, uint32 color)'),
    createFont: gdi.func('void * __stdcall CreateFontW(int height, int width, int escapement, int orientation, int weight, uint32 italic, uint32 underline, uint32 strikeout, uint32 charset, uint32 outputPrecision, uint32 clipPrecision, uint32 quality, uint32 pitch, const char16_t *face)'),
    ellipse: gdi.func('int __stdcall Ellipse(void *dc, int left, int top, int right, int bottom)'),
    textColor: gdi.func('uint32 __stdcall SetTextColor(void *dc, uint32 color)'),
    backgroundMode: gdi.func('int __stdcall SetBkMode(void *dc, int mode)'),
    drawText: user.func('__stdcall', 'DrawTextW', 'int', ['void *', 'str16', 'int', koffi.inout(koffi.pointer(rect)), 'uint32']),
    flush: gdi.func('int __stdcall GdiFlush()'),
  }
}

let bindings: ReturnType<typeof loadGdi> | undefined

function checkedHandle(handle: unknown, operation: string): unknown {
  if (handle === null) throw new Error(`Desktop taskbar: ${operation} failed`)
  return handle
}

function checkedCall(success: unknown, operation: string): void {
  if (success === 0) throw new Error(`Desktop taskbar: ${operation} failed`)
}

function releaseGdi(gdi: ReturnType<typeof loadGdi>, dc: unknown, objects: readonly unknown[]): void {
  const failures: unknown[] = []
  // Deleting the private DC first releases all selections, including on a failed SelectObject.
  try { checkedCall(gdi.deleteDC(dc), 'DeleteDC') } catch (error) { failures.push(error) }
  for (const object of objects.toReversed()) {
    try { checkedCall(gdi.deleteObject(object), 'DeleteObject') } catch (error) { failures.push(error) }
  }
  if (failures.length !== 0) throw new AggregateError(failures, 'Desktop taskbar: GDI cleanup failed')
}

function drawMask(gdi: ReturnType<typeof loadGdi>, dc: unknown, objects: unknown[], label: string): void {
  const own = (handle: unknown, operation: string): unknown => {
    const owned = checkedHandle(handle, operation)
    objects.push(owned)
    return owned
  }
  const pen = own(gdi.createPen(0, SCALE, 0xffffff), 'CreatePen')
  const fontHeight = label.length === 1 ? 10 : label.length === 2 ? 8 : 6
  const font = own(gdi.createFont(-fontHeight * SCALE,
    0, 0, 0, 700, 0, 0, 0, 1, 0, 0, 4, 0, 'Segoe UI'), 'CreateFontW')
  checkedHandle(gdi.selectObject(dc, pen), 'SelectObject pen')
  checkedHandle(gdi.selectObject(dc, checkedHandle(gdi.stockObject(5), 'GetStockObject')), 'SelectObject hollow brush')
  checkedCall(gdi.ellipse(dc, SCALE, SCALE, RASTER_SIZE - SCALE, RASTER_SIZE - SCALE), 'Ellipse')
  checkedHandle(gdi.selectObject(dc, font), 'SelectObject font')
  if (gdi.textColor(dc, 0xffffff) === 0xffffffff) throw new Error('Desktop taskbar: SetTextColor failed')
  checkedCall(gdi.backgroundMode(dc, 1), 'SetBkMode')
  checkedCall(gdi.drawText(dc, label, label.length,
    { left: 2 * SCALE, top: SCALE, right: RASTER_SIZE - 2 * SCALE, bottom: RASTER_SIZE - SCALE }, 0x25), 'DrawTextW')
  checkedCall(gdi.flush(), 'GdiFlush')
}

function whiteOverlay(mask: Uint8Array): Buffer {
  const bitmap = Buffer.alloc(SIZE * SIZE * 4)
  const pixels = new DataView(mask.buffer, mask.byteOffset, mask.byteLength)
  // GDI does not preserve DIB alpha. White-on-black coverage becomes premultiplied white BGRA.
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      let coverage = 0
      for (let dy = 0; dy < SCALE; dy++) {
        for (let dx = 0; dx < SCALE; dx++) coverage += pixels.getUint8(((y * SCALE + dy) * RASTER_SIZE + x * SCALE + dx) * 4)
      }
      bitmap.fill(Math.round(coverage / (SCALE * SCALE)), (y * SIZE + x) * 4, (y * SIZE + x + 1) * 4)
    }
  }
  return bitmap
}

/**
 * Rasterize a positive accepted count as a white ring and system-font number; counts above 99 display 99+.
 * @param count - positive safe integer already validated by private main-process IPC.
 * @returns Transparent 16×16 premultiplied BGRA for Windows nativeImage.createFromBitmap; GDI failures throw.
 */
export function taskbarUnreadBitmap(count: number): Buffer {
  const gdi = bindings ??= loadGdi()
  const dc = checkedHandle(gdi.createDC(null), 'CreateCompatibleDC')
  const objects: unknown[] = []
  try {
    const bits: unknown[] = [null]
    const bitmap = checkedHandle(gdi.createBitmap(dc, {
      size: 40, width: RASTER_SIZE, height: -RASTER_SIZE, planes: 1, bitCount: 32, compression: 0,
      sizeImage: 0, xPixels: 0, yPixels: 0, colorsUsed: 0, colorsImportant: 0, color: 0,
    }, 0, bits, null, 0), 'CreateDIBSection')
    objects.push(bitmap)
    const pixels = checkedHandle(bits[0], 'DIB pixels')
    // Electron forbids unmanaged ArrayBuffer views; copy through Koffi's value codec.
    koffi.encode(pixels, gdi.pixelBytes, new Uint8Array(RASTER_SIZE * RASTER_SIZE * 4))
    checkedHandle(gdi.selectObject(dc, bitmap), 'SelectObject bitmap')
    drawMask(gdi, dc, objects, count > 99 ? '99+' : String(count))
    const mask: unknown = koffi.decode(pixels, gdi.pixelBytes)
    if (!(mask instanceof Uint8Array)) throw new Error('Desktop taskbar: invalid decoded DIB pixels')
    return whiteOverlay(mask)
  } finally {
    releaseGdi(gdi, dc, objects)
  }
}
