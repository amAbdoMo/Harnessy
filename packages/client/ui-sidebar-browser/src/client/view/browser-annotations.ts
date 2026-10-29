/** Screenshot-space annotation geometry and raster output. */
/** One screenshot-space pixel coordinate. */
export interface AnnotationPoint { readonly x: number; readonly y: number }
/** Screenshot-space bounds independent of drag direction. */
export interface AnnotationRect { readonly x: number; readonly y: number; readonly width: number; readonly height: number }
/** User-authored screenshot feedback and optional selected element context. */
export type BrowserAnnotation =
  | { readonly kind: 'region'; readonly rect: AnnotationRect }
  | { readonly kind: 'stroke'; readonly points: readonly AnnotationPoint[] }
  | { readonly kind: 'element'; readonly rect: AnnotationRect; readonly selector: string; readonly tagName: string; readonly text: string }

/** Normalize a dragged rectangle in screenshot coordinates.
 * @param start - first corner.
 * @param end - opposite corner.
 * @returns normalized rectangle.
 */
export function annotationRect(start: AnnotationPoint, end: AnnotationPoint): AnnotationRect {
  return { x: Math.min(start.x, end.x), y: Math.min(start.y, end.y), width: Math.abs(end.x - start.x), height: Math.abs(end.y - start.y) }
}

/** Locate feedback under the eraser.
 * @param annotation - shape to test.
 * @param point - eraser position.
 * @returns whether its bounds contain the point.
 */
export function annotationHit(annotation: BrowserAnnotation, point: AnnotationPoint): boolean {
  if (annotation.kind === 'stroke') return annotation.points.some(candidate => Math.hypot(candidate.x - point.x, candidate.y - point.y) <= 12)
  const { rect } = annotation
  return point.x >= rect.x - 4 && point.y >= rect.y - 4 && point.x <= rect.x + rect.width + 4 && point.y <= rect.y + rect.height + 4
}

/** Rasterize feedback over the captured image.
 * @param png - captured base64 PNG.
 * @param annotations - screenshot-space shapes.
 * @returns annotated PNG file.
 */
export async function annotatedBrowserFile(png: string, annotations: readonly BrowserAnnotation[]): Promise<File> {
  const image = new Image()
  image.src = `data:image/png;base64,${png}`
  await image.decode()
  const canvas = document.createElement('canvas')
  canvas.width = image.naturalWidth
  canvas.height = image.naturalHeight
  const context = canvas.getContext('2d')
  if (context === null) throw new Error('Browser screenshot drawing is unavailable')
  context.drawImage(image, 0, 0)
  context.strokeStyle = '#3b82f6'
  context.lineWidth = 3
  context.lineJoin = 'round'
  context.lineCap = 'round'
  for (const annotation of annotations) {
    if (annotation.kind !== 'stroke') {
      const { rect } = annotation
      context.strokeRect(rect.x, rect.y, rect.width, rect.height)
      continue
    }
    context.beginPath()
    annotation.points.forEach((point, index) => {
      if (index === 0) context.moveTo(point.x, point.y)
      else context.lineTo(point.x, point.y)
    })
    context.stroke()
  }
  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((value) => {
      if (value === null) reject(new Error('Browser screenshot encoding failed'))
      else resolve(value)
    }, 'image/png')
  })
  return new File([blob], 'browser-feedback.png', { type: 'image/png' })
}
