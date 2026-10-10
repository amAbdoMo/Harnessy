/** CSS viewport geometry stays independent of presentation scaling. */

/** Supported decorative hardware families. */
export type DeviceKind = 'ios-phone' | 'android-phone' | 'ios-tablet' | 'android-tablet'
/** Independent preview browser lanes. */
export type DeviceLane = 'phone' | 'tablet'
/** Screenshot assets are selected for this orientation, never rotated. */
export type DeviceOrientation = 'portrait' | 'landscape'
/** Screen dimensions in CSS pixels, not physical device pixels. */
export interface DeviceViewport { readonly width: number; readonly height: number }
/** Bounds protect custom viewport allocation; they are not device presets. */
export const VIEWPORT_BOUNDS = { min: 240, max: 2560 } as const
/** Portrait CSS dimensions; device chrome is excluded. */
export const DEVICE_PRESETS: Readonly<Record<DeviceKind, DeviceViewport>> = {
  'ios-phone': { width: 393, height: 852 },
  'android-phone': { width: 412, height: 915 },
  'ios-tablet': { width: 820, height: 1180 },
  'android-tablet': { width: 800, height: 1280 },
}
/**
 * Validate text at the custom-dimension input, before changing the viewport.
 * @param text - human-entered dimension.
 * @returns bounded integer dimension, or absence for invalid input.
 */
export function parseDimension(text: string): number | undefined {
  if (!/^\d+$/.test(text.trim())) return undefined
  const dimension = Number(text)
  return dimension >= VIEWPORT_BOUNDS.min && dimension <= VIEWPORT_BOUNDS.max ? dimension : undefined
}
/**
 * Resolve CSS dimensions without modifying or rotating browser content.
 * @param dimensions - portrait dimensions.
 * @param orientation - requested screen orientation.
 * @returns dimensions sent to the browser adapter.
 */
export function orientedViewport(dimensions: DeviceViewport, orientation: DeviceOrientation): DeviceViewport {
  return orientation === 'portrait' ? dimensions : { width: dimensions.height, height: dimensions.width }
}
/**
 * Fit complete hardware chrome inside the measured panel; never upscale it.
 * @param panel - available panel content size.
 * @param viewport - unscaled screen size.
 * @param bezel - CSS pixels around each edge of the screen.
 * @returns display-only scale, zero while the panel has no measurable space.
 */
export function fitDeviceScale(panel: DeviceViewport, viewport: DeviceViewport, bezel: number): number {
  return Math.max(0, Math.min(1, panel.width / (viewport.width + bezel * 2), panel.height / (viewport.height + bezel * 2)))
}
/**
 * Give tablets a wider hardware border without shrinking the CSS screen.
 * @param kind - hardware decoration.
 * @returns border width in CSS pixels.
 */
export function deviceBezel(kind: DeviceKind): number { return kind.endsWith('tablet') ? 22 : 12 }
