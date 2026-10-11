/** Source install metadata and profile projection; no Web build or server. */
import * as fs from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, it, vi } from 'vitest'
import { clientDocumentIdentity } from '../client-document-identity.ts'

const publicRoot = new URL('../public/', import.meta.url)
const distManifestPath = fileURLToPath(new URL('../dist/manifest.webmanifest', import.meta.url))
const manifestText = readFileSync(new URL('manifest.webmanifest', publicRoot), 'utf8')
const index = readFileSync(new URL('../index.html', import.meta.url), 'utf8')
type Manifest = {
  name: string
  short_name: string
  start_url: string
  scope: string
  display: string
  icons: { src: string; sizes: string; type: string; purpose: string }[]
}

afterEach(() => { vi.restoreAllMocks() })

function assertStandardIcons(manifest: Manifest): void {
  const standard = manifest.icons.filter(icon => icon.type === 'image/png')
  expect(standard.map(icon => icon.sizes)).toEqual(['192x192', '512x512'])
  for (const icon of standard) {
    const png = readFileSync(new URL(icon.src, publicRoot))
    expect(png.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a')
    expect(`${png.readUInt32BE(16)}x${png.readUInt32BE(20)}`).toBe(icon.sizes)
    expect(icon.purpose).toBe('any')
  }
}

it('starts at the clean mount root and ships standard PNG icons', () => {
  const manifest = JSON.parse(manifestText) as Manifest
  const origin = new URL('https://companion.example/manifest.webmanifest')
  const start = new URL(manifest.start_url, origin)
  expect(start.href).toBe('https://companion.example/')
  expect(new URL(manifest.scope, origin).href).toBe(start.href)
  expect(manifest.display).toBe('standalone')
  assertStandardIcons(manifest)
  expect(index).toContain('viewport-fit=cover, interactive-widget=resizes-content')
  expect(index).toContain('href="/manifest.webmanifest"')
})

const profiles: { label: string; environment: Record<string, string>; prefix: string; name: string; short: string }[] = [
  { label: 'fallback', environment: {}, prefix: 'dsh', name: 'DeepSeek Harness', short: 'DSH' },
  { label: 'official', environment: { DSH_CLIENT_TITLE: 'DeepSeek Harness' }, prefix: 'dsh', name: 'DeepSeek Harness', short: 'DSH' },
  { label: 'explicit fallback', environment: { DSH_CLIENT_ICON_PATH: '/favicon.svg' }, prefix: 'dsh', name: 'DeepSeek Harness', short: 'DSH' },
  { label: 'Harnessy', environment: {
    DSH_CLIENT_TITLE: 'Harnessy', DSH_CLIENT_PRODUCT_NAME: 'Harnessy',
    DSH_CLIENT_MANIFEST_SHORT_NAME: 'Harnessy', DSH_CLIENT_ICON_PATH: '/harnessy.png',
  }, prefix: 'harnessy', name: 'Harnessy', short: 'Harnessy' },
]

it.each(profiles)('preserves $label identity with correctly sized install icons', async ({ environment, prefix, name, short }) => {
  let written = manifestText
  vi.spyOn(fs, 'readFile').mockResolvedValue(manifestText)
  vi.spyOn(fs, 'writeFile').mockImplementation(async (_path, contents) => { if (typeof contents !== 'string') throw new Error('Expected manifest text'); written = contents })
  const plugin = clientDocumentIdentity(environment)
  const close = plugin.closeBundle
  if (typeof close !== 'function') throw new Error('document identity must expose its manifest projection')
  await close.call({} as never)
  const manifest = JSON.parse(written) as Manifest
  expect(manifest.name).toBe(name)
  expect(manifest.short_name).toBe(short)
  expect(manifest.start_url).toBe('./')
  expect(manifest.scope).toBe('./')
  assertStandardIcons(manifest)
  expect(manifest.icons.filter(icon => icon.type === 'image/png').map(icon => icon.src))
    .toEqual([`${prefix}-mobile-192.png`, `${prefix}-mobile-512.png`])
  const transform = plugin.transformIndexHtml
  if (typeof transform !== 'function') throw new Error('document identity must expose its HTML projection')
  const html = await transform(index, {} as never)
  if (prefix === 'harnessy') {
    expect(html).not.toContain('type="image/svg+xml"')
    expect(html).not.toContain('favicon-dark.svg')
    expect(html).toContain('href="/harnessy.png"')
  } else {
    expect(html).toContain('href="/favicon.svg"')
    expect(html).toContain('href="/favicon-dark.svg"')
  }
})

it('escapes build identity before placing it in HTML text and attributes', async () => {
  const transform = clientDocumentIdentity({
    DSH_CLIENT_TITLE: 'Operator <phone> & "PC"', DSH_CLIENT_ICON_PATH: '/operator"logo.svg',
  }).transformIndexHtml
  if (typeof transform !== 'function') throw new Error('document identity must expose its HTML projection')
  const html = await transform(index, {} as never)
  expect(html).toContain('<title>Operator &lt;phone&gt; &amp; &quot;PC&quot;</title>')
  expect(html).toContain('href="/operator&quot;logo.svg"')
  expect(html).not.toContain('href="/operator"logo.svg"')
})

it.each([
  { path: '/favicon-dark.svg', data: undefined, sizes: 'any', mime: 'image/svg+xml' },
  { path: '/another-product.png', data: readFileSync(new URL('harnessy-mobile-192.png', publicRoot)), sizes: '192x192', mime: 'image/png' },
])('keeps an explicit $path product icon with its actual format and size', async ({ path, data, sizes, mime }) => {
  let written = ''
  vi.spyOn(fs, 'readFile').mockImplementation(async target => target === distManifestPath ? manifestText : data!)
  vi.spyOn(fs, 'writeFile').mockImplementation(async (_path, contents) => { if (typeof contents !== 'string') throw new Error('Expected manifest text'); written = contents })
  const close = clientDocumentIdentity({ DSH_CLIENT_ICON_PATH: path }).closeBundle
  if (typeof close !== 'function') throw new Error('manifest projection is missing')
  await close.call({} as never)
  expect((JSON.parse(written) as Manifest).icons).toEqual([{ src: path, sizes, type: mime, purpose: 'any' }])
})

it('refuses an install icon whose PNG extension hides another format', async () => {
  vi.spyOn(fs, 'readFile').mockImplementation(async target => target === distManifestPath
    ? manifestText : Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" />'))
  const close = clientDocumentIdentity({ DSH_CLIENT_ICON_PATH: '/not-png.png' }).closeBundle
  if (typeof close !== 'function') throw new Error('manifest projection is missing')
  await expect(close.call({} as never)).rejects.toThrow('Web install icon must contain PNG data')
})
