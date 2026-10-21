/** Koffi system-call fixture with selected-object lifetime checks; no native libraries are loaded. */
import { vi, type Mock } from 'vitest'

type Handle = { kind: string }
type GdiCall = (...args: never[]) => unknown

/** @returns Isolated Koffi mock, GDI calls and live owned handles for raster failure tests. */
export function createGdiMock() {
  const owned = new Set<Handle>()
  const selected = new Set<Handle>()
  const calls: Record<string, Mock<GdiCall>> = {}
  let pixels = new ArrayBuffer(64 * 64 * 4)
  const allocate = (kind: string): Handle => {
    const handle = { kind }
    owned.add(handle)
    return handle
  }
  const implementations: Record<string, GdiCall> = {
    CreateCompatibleDC: () => allocate('dc'),
    CreateDIBSection: (_dc: Handle, _info: object, _usage: number, out: unknown[]) => {
      pixels = new ArrayBuffer(64 * 64 * 4)
      out[0] = pixels
      return allocate('bitmap')
    },
    CreatePen: () => allocate('pen'),
    CreateFontW: () => allocate('font'),
    GetStockObject: () => ({ kind: 'brush' }),
    SelectObject: (_dc: Handle, object: Handle) => { selected.add(object); return { kind: object.kind } },
    DeleteDC: (dc: Handle) => { selected.clear(); owned.delete(dc); return 1 },
    DeleteObject: (object: Handle) => {
      if (selected.has(object)) throw new Error('Deleting selected GDI object')
      if (!owned.delete(object)) throw new Error('Deleting unowned GDI object')
      return 1
    },
    Ellipse: () => 1,
    SetTextColor: () => 0,
    SetBkMode: () => 1,
    DrawTextW: () => { new Uint8Array(pixels).fill(255, (32 * 64 + 32) * 4, (32 * 64 + 33) * 4); return 32 },
    GdiFlush: () => 1,
  }
  for (const [name, implementation] of Object.entries(implementations)) calls[name] = vi.fn(implementation)
  const library = {
    func: (definition: string, name?: string) => {
      const functionName = name ?? /__stdcall (\w+)\(/u.exec(definition)?.[1]
      const call = functionName === undefined ? undefined : calls[functionName]
      if (call === undefined) throw new Error(`Unexpected GDI declaration: ${definition}`)
      return call
    },
  }
  return {
    calls, owned,
    koffi: { load: () => library, struct: (fields: object) => fields, pointer: (type: unknown) => type,
      out: (type: unknown) => type, inout: (type: unknown) => type,
      array: (_type: string, length: number) => ({ length }),
      encode: (pointer: ArrayBuffer, _type: object, bytes: Uint8Array) => { new Uint8Array(pointer).set(bytes) },
      decode: (pointer: ArrayBuffer) => new Uint8Array(pointer).slice() },
  }
}
