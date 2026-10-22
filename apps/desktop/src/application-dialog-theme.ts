/** Capture only resolved application colors for an isolated, Main-owned shell dialog. */
import { addAbortListener } from 'node:events'
import type { WebContents } from 'electron'

const tokens = {
  surface: '--dsw-alias-bg-layer-2',
  text: '--dsw-alias-label-primary',
  muted: '--dsw-alias-label-secondary',
  border: '--dsw-alias-border-l3',
  primary: '--dsw-alias-brand-primary',
  primaryText: '--dsw-alias-brand-primary-invert',
  secondary: '--dsw-alias-bg-layer-3',
} as const

/** Resolved sRGB colors only; no application text, stylesheets, URLs, or capabilities. */
export type ApplicationDialogTheme = Readonly<Record<keyof typeof tokens, string> & { dark: boolean }>

/** Runs in the product document; canvas resolves custom CSS color spaces into bounded RGBA bytes. */
function captureColors(names: Record<string, string>): Record<string, string | boolean> {
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = 1
  const context = canvas.getContext('2d', { willReadFrequently: true })
  if (context === null) throw new Error('Application dialog requires a 2D color context')
  const probe = document.createElement('span')
  probe.style.cssText = 'position:fixed;visibility:hidden;pointer-events:none'
  document.body.append(probe)
  try {
    const result: Record<string, string | boolean> = { dark: document.body.hasAttribute('data-ds-dark-theme') }
    for (const [name, token] of Object.entries(names)) {
      if (getComputedStyle(document.body).getPropertyValue(token).trim() === '') throw new Error('Application dialog theme is not ready')
      probe.style.color = `var(${token})`
      context.clearRect(0, 0, 1, 1)
      context.fillStyle = getComputedStyle(probe).color
      context.fillRect(0, 0, 1, 1)
      result[name] = '#' + [...context.getImageData(0, 0, 1, 1).data].map(byte => byte.toString(16).padStart(2, '0')).join('')
    }
    return result
  } finally {
    probe.remove()
  }
}

/**
 * Read the current app palette without allowing renderer data to become CSS or dialog choices.
 * @param contents - Captured product document owning the requested dialog.
 * @param signal - Management lifetime; cancellation stops waiting without publishing late colors.
 * @returns Validated color-only presentation data; rejects if the document is unavailable or malformed.
 */
export async function readApplicationDialogTheme(contents: Pick<WebContents, 'executeJavaScript'>, signal?: AbortSignal): Promise<ApplicationDialogTheme> {
  signal?.throwIfAborted()
  const cancelled = Promise.withResolvers<never>()
  const listener = signal === undefined ? undefined : addAbortListener(signal, () => { cancelled.reject(signal.reason) })
  let value: unknown
  try {
    value = await Promise.race([
      contents.executeJavaScript(`(${captureColors.toString()})(${JSON.stringify(tokens)})`), cancelled.promise,
    ])
  } finally {
    listener?.[Symbol.dispose]()
  }
  signal?.throwIfAborted()
  if (typeof value !== 'object' || value === null || typeof Reflect.get(value, 'dark') !== 'boolean') {
    throw new Error('Application dialog theme is unavailable')
  }
  const color = (name: keyof typeof tokens): string => {
    const result: unknown = Reflect.get(value, name)
    if (typeof result !== 'string' || !/^#[\da-f]{8}$/iu.test(result)) throw new Error('Invalid application dialog color')
    return result
  }
  return {
    dark: Reflect.get(value, 'dark') === true,
    surface: color('surface'), text: color('text'), muted: color('muted'), border: color('border'),
    primary: color('primary'), primaryText: color('primaryText'), secondary: color('secondary'),
  }
}
