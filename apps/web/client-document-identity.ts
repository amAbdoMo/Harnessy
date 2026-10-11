/** Build-time HTML identity and install metadata; contains no Host or browser credentials. */
import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import type { Plugin } from 'vite'

const src = (rel: string): string => fileURLToPath(new URL(rel, import.meta.url))
const DEFAULT_CLIENT_TITLE = 'DSH Local Build'

/** Escape public build text before placing it in an HTML element or attribute. */
function escapeHtmlText(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

/**
 * Project public build identity into the initial HTML and install metadata.
 * @param environment - Complete public identity selected by the caller's build profile.
 * @returns The document and manifest Vite plugin.
 */
export function clientDocumentIdentity(environment: Readonly<Record<string, string>>): Plugin {
  const title = escapeHtmlText(environment.DSH_CLIENT_TITLE ?? DEFAULT_CLIENT_TITLE)
  const productName = environment.DSH_CLIENT_PRODUCT_NAME
  const shortName = environment.DSH_CLIENT_MANIFEST_SHORT_NAME
  const iconPath = environment.DSH_CLIENT_ICON_PATH
  return {
    name: 'dsh-client-document-identity',
    transformIndexHtml(html) {
      const titled = html.replace('<title>DSH Local Build</title>', `<title>${title}</title>`)
      if (iconPath === undefined || iconPath === '/favicon.svg') return titled
      const branded = titled.replace(/href=["']\.?\/favicon(?:-dark)?\.svg["']/gu, `href="${escapeHtmlText(iconPath)}"`)
      return iconPath.endsWith('.png')
        ? branded.replace(/(<link\s+rel=["']icon["']\s+type=["'])image\/svg\+xml/gu, '$1image/png')
        : branded
    },
    async closeBundle() {
      if (productName === undefined && shortName === undefined && iconPath === undefined) return
      const path = src('./dist/manifest.webmanifest')
      const manifest = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
      if (productName !== undefined) manifest.name = productName
      if (shortName !== undefined) manifest.short_name = shortName
      if (iconPath === '/harnessy.png') {
        manifest.icons = [192, 512].map(size => ({
          src: `harnessy-mobile-${size}.png`, sizes: `${size}x${size}`, type: 'image/png', purpose: 'any',
        }))
      } else if (iconPath !== undefined && iconPath !== '/favicon.svg') {
        const png = iconPath.endsWith('.png')
        const image = png ? await readFile(src(`./public/${iconPath.replace(/^\//u, '')}`)) : undefined
        if (image !== undefined && (image.length < 24 || image.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a')) {
          throw new Error(`Web install icon must contain PNG data: ${iconPath}`)
        }
        manifest.icons = [{
          src: iconPath,
          sizes: image === undefined ? 'any' : `${image.readUInt32BE(16)}x${image.readUInt32BE(20)}`,
          type: png ? 'image/png' : 'image/svg+xml', purpose: 'any',
        }]
      }
      await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`)
    },
  }
}
