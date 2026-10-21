/** Integer CSS viewport resizing; pointer deltas always use the gesture's initial dimensions and display scale. */
import { VIEWPORT_BOUNDS, type DeviceViewport } from './viewport.ts'

/** Clockwise frame edges and corners. */
export const RESIZE_DIRECTIONS = ['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw'] as const
/** An edge changes one axis; a corner changes both. */
export type ResizeDirection = typeof RESIZE_DIRECTIONS[number]

function bounded(dimension: number): number {
  return Math.min(VIEWPORT_BOUNDS.max, Math.max(VIEWPORT_BOUNDS.min, Math.round(dimension)))
}

/**
 * Resolve movement from the original press, never from a previous update.
 * @param start - oriented CSS dimensions at pointerdown.
 * @param direction - dragged edge or corner.
 * @param movement - total screen-pixel movement from pointerdown.
 * @param scale - positive display scale captured at pointerdown.
 * @returns bounded integer CSS dimensions in the displayed orientation.
 */
export function resizeFromPointer(
  start: DeviceViewport, direction: ResizeDirection, movement: { x: number; y: number }, scale: number,
): DeviceViewport {
  return {
    width: bounded(start.width + (direction.includes('e') ? movement.x / scale : direction.includes('w') ? -movement.x / scale : 0)),
    height: bounded(start.height + (direction.includes('s') ? movement.y / scale : direction.includes('n') ? -movement.y / scale : 0)),
  }
}

/**
 * Keep the opposite edge fixed while the north or west edge moves.
 * @param start - oriented dimensions at pointerdown.
 * @param current - bounded dimensions currently applied.
 * @param direction - dragged edge or corner.
 * @param scale - frozen display scale.
 * @returns screen-pixel displacement of the frame's top-left origin.
 */
export function resizeOrigin(
  start: DeviceViewport, current: DeviceViewport, direction: ResizeDirection, scale: number,
): { left: number; top: number } {
  return {
    left: direction.includes('w') ? (start.width - current.width) * scale : 0,
    top: direction.includes('n') ? (start.height - current.height) * scale : 0,
  }
}

/**
 * Move the focused edge in the arrow's screen direction, independently of display scale.
 * @param viewport - current oriented CSS dimensions.
 * @param direction - focused edge or corner.
 * @param event - pressed key; Shift selects ten CSS pixels instead of one.
 * @returns resized viewport, or absence for a key unrelated to this handle's axes.
 */
export function resizeFromKey(viewport: DeviceViewport, direction: ResizeDirection, event: Pick<KeyboardEvent, 'key' | 'shiftKey'>): DeviceViewport | undefined {
  const step = event.shiftKey ? 10 : 1
  const dx = event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0
  const dy = event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0
  if ((dx !== 0 && /[ew]/.test(direction)) || (dy !== 0 && /[ns]/.test(direction))) {
    return resizeFromPointer(viewport, direction, { x: dx, y: dy }, 1)
  }
  return undefined
}
