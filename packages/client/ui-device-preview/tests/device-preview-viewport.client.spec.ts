import { describe, expect, it } from 'vitest'
import type { TabId } from '@deepseek-ai/dsh-client-ui-dockkit'
import { deviceBezel, DEVICE_PRESETS, fitDeviceScale, orientedViewport, parseDimension } from '../src/client/viewport.ts'
import { createDevicePreviewStore } from '../src/client/store.ts'

const TAB = 'device-preview' as TabId

describe('Device preview CSS viewport', () => {
  it.each([
    ['240', 240], ['2560', 2560], [' 820 ', 820], ['', undefined], ['239', undefined],
    ['2561', undefined], ['393.5', undefined], ['1e3', undefined], ['-820', undefined], ['Infinity', undefined],
  ])('accepts bounded whole-pixel dimensions from %j', (input, expected) => {
    expect(parseDimension(input)).toBe(expected)
  })

  it.each(Object.entries(DEVICE_PRESETS))('fits %s without changing its CSS viewport', (kind, viewport) => {
    const bezel = deviceBezel(kind as keyof typeof DEVICE_PRESETS)
    const original = { ...viewport }
    const scale = fitDeviceScale({ width: 300, height: 600 }, viewport, bezel)
    expect((viewport.width + bezel * 2) * scale).toBeLessThanOrEqual(300)
    expect((viewport.height + bezel * 2) * scale).toBeLessThanOrEqual(600)
    expect(viewport).toEqual(original)
    expect(fitDeviceScale({ width: 5000, height: 5000 }, viewport, bezel)).toBe(1)
    expect(fitDeviceScale({ width: 0, height: 0 }, viewport, bezel)).toBe(0)
  })

  it('preserves custom portrait dimensions through rotation, fit changes and hardware changes', () => {
    const store = createDevicePreviewStore().create()
    store.actions.initialize(TAB, 'https://example.test/')
    store.actions.setDimensions(TAB, 'phone', { width: 360, height: 760 })
    store.actions.setOrientation(TAB, 'phone', 'landscape')
    store.actions.setScale(TAB, 'phone', 0.4)
    store.actions.setZoom(TAB, 'phone', 'actual')
    store.actions.setKind(TAB, 'phone', 'android-phone')
    const phone = store.getSnapshot().byTab[TAB]!.phone
    expect(orientedViewport(phone.dimensions, phone.orientation)).toEqual({ width: 760, height: 360 })
    expect(phone.dimensions).toEqual({ width: 360, height: 760 })
    expect(store.getSnapshot().byTab[TAB]!.tablet.dimensions).toEqual(DEVICE_PRESETS['ios-tablet'])
    store.actions.setPreset(TAB, 'phone')
    expect(store.getSnapshot().byTab[TAB]!.phone.dimensions).toEqual(DEVICE_PRESETS['android-phone'])
  })

  it('keeps per-orientation images and tab view state separate', () => {
    const store = createDevicePreviewStore().create()
    const other = 'other-preview' as TabId
    store.actions.initialize(TAB, '')
    store.actions.initialize(other, 'https://other.test/')
    store.actions.setImage(TAB, 'phone', 'portrait', { name: 'portrait.png', src: 'data:image/png;base64,AA==' })
    store.actions.setOrientation(TAB, 'phone', 'landscape')
    expect(store.getSnapshot().byTab[TAB]!.phone.images.landscape).toBeUndefined()
    expect(store.getSnapshot().byTab[TAB]!.phone.images.portrait?.name).toBe('portrait.png')
    expect(store.getSnapshot().byTab[TAB]!.tablet.images).toEqual({})
    store.actions.setImage(TAB, 'phone', 'portrait', undefined)
    expect(store.getSnapshot().byTab[TAB]!.phone.images).toEqual({})
    store.actions.forget(TAB)
    expect(store.getSnapshot().byTab[TAB]).toBeUndefined()
    expect(store.getSnapshot().byTab[other]!.urlDraft).toBe('https://other.test/')
  })
})
