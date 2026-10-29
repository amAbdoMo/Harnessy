/** Human-requested screenshot and element context from one Main-validated browser guest. */
import type { NativeImage, WebContents } from 'electron'
import type { BrowserAnnotationCapture, BrowserPickedElement } from '@deepseek-ai/dsh-client-ui-sidebar-browser/types'

const MAX_CAPTURE_BYTES = 16 * 1024 * 1024

interface AnnotationGuest {
  readonly getURL: WebContents['getURL']
  readonly getTitle: WebContents['getTitle']
  readonly isDestroyed: WebContents['isDestroyed']
  readonly executeJavaScriptInIsolatedWorld: WebContents['executeJavaScriptInIsolatedWorld']
  capturePage(): Promise<Pick<NativeImage, 'isEmpty' | 'toPNG' | 'getSize'>>
}

/** @param guest - exact live guest belonging to the requesting renderer. @returns its visible PNG and page context. */
export async function captureBrowserAnnotation(guest: AnnotationGuest): Promise<BrowserAnnotationCapture> {
  if (guest.isDestroyed()) throw new Error('Browser tab is closed')
  const url = guest.getURL()
  const title = guest.getTitle()
  const viewport: unknown = await guest.executeJavaScriptInIsolatedWorld(999, [{ code: '({width: innerWidth, height: innerHeight})' }])
  if (typeof viewport !== 'object' || viewport === null || !('width' in viewport) || typeof viewport.width !== 'number'
    || !('height' in viewport) || typeof viewport.height !== 'number' || !Number.isFinite(viewport.width)
    || !Number.isFinite(viewport.height) || viewport.width <= 0 || viewport.height <= 0) throw new Error('Browser viewport is unavailable')
  const image = await guest.capturePage()
  if (guest.isDestroyed() || guest.getURL() !== url) throw new Error('Browser page changed during capture; capture it again')
  if (image.isEmpty()) throw new Error('Browser screenshot is empty')
  const png = image.toPNG()
  const { width, height } = image.getSize()
  if (png.byteLength > MAX_CAPTURE_BYTES || width <= 0 || height <= 0) throw new Error('Browser screenshot exceeds the capture limit')
  return { png: png.toString('base64'), width, height, viewportWidth: viewport.width, viewportHeight: viewport.height, url, title }
}

const PICK_ELEMENT = `(point => {
  let element = document.elementFromPoint(point.x, point.y);
  if (!element) return null;
  while (element.shadowRoot) {
    const inner = element.shadowRoot.elementFromPoint(point.x, point.y);
    if (!inner || inner === element) break;
    element = inner;
  }
  const rect = element.getBoundingClientRect();
  const parts = [];
  for (let node = element; node && node.nodeType === 1; node = node.parentElement) {
    if (node.id) { parts.unshift('#' + CSS.escape(node.id)); break; }
    const tag = node.tagName.toLowerCase();
    const siblings = node.parentElement ? [...node.parentElement.children].filter(child => child.tagName === node.tagName) : [];
    parts.unshift(siblings.length > 1 ? tag + ':nth-of-type(' + (siblings.indexOf(node) + 1) + ')' : tag);
  }
  const text = element.matches('input,textarea,select,[contenteditable]') ? '' : (element.textContent || '').slice(0, 2048);
  return { selector: parts.join(' > ').slice(0, 4096), tagName: element.tagName.toLowerCase(), text,
    rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height } };
})`

function isPickedElement(value: unknown): value is BrowserPickedElement {
  if (typeof value !== 'object' || value === null || !('selector' in value) || typeof value.selector !== 'string'
    || !('tagName' in value) || typeof value.tagName !== 'string' || !('text' in value) || typeof value.text !== 'string'
    || !('rect' in value) || typeof value.rect !== 'object' || value.rect === null) return false
  const rect = value.rect
  return 'x' in rect && typeof rect.x === 'number' && Number.isFinite(rect.x)
    && 'y' in rect && typeof rect.y === 'number' && Number.isFinite(rect.y)
    && 'width' in rect && typeof rect.width === 'number' && Number.isFinite(rect.width) && rect.width >= 0
    && 'height' in rect && typeof rect.height === 'number' && Number.isFinite(rect.height) && rect.height >= 0
}

/** @param guest - exact live guest belonging to the requesting renderer. @param point - CSS viewport coordinates.
 * @returns bounded element context, or null when no element occupies that point; form values are omitted.
 */
export async function pickBrowserElement(guest: Pick<WebContents, 'executeJavaScriptInIsolatedWorld' | 'isDestroyed'>,
  point: { readonly x: number; readonly y: number }): Promise<BrowserPickedElement | null> {
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y) || point.x < 0 || point.y < 0
    || point.x > 8192 || point.y > 8192) throw new Error('Browser selection coordinates are invalid')
  if (guest.isDestroyed()) throw new Error('Browser tab is closed')
  const selected: unknown = await guest.executeJavaScriptInIsolatedWorld(999, [{ code: `${PICK_ELEMENT}(${JSON.stringify(point)})` }])
  if (guest.isDestroyed()) throw new Error('Browser tab is closed')
  if (selected === null) return null
  if (!isPickedElement(selected)) throw new Error('Browser selection returned invalid element context')
  return selected
}
