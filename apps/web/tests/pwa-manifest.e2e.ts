import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join, resolve } from 'node:path'
import { expect, it } from 'vitest'

const DIST_ROOT = fileURLToPath(new URL('../dist', import.meta.url))
const buildRecord = JSON.parse(await readFile(
  resolve(import.meta.dirname, '../../../.dsh-build/client-build-environment.json'),
  'utf8',
)) as { environment: Record<string, string> }
const build = buildRecord.environment
const custom = build.DSH_CLIENT_BUILD_PROFILE === 'custom-harness'

it('ships install metadata with the built web application', async () => {
  const index = await readFile(join(DIST_ROOT, 'index.html'), 'utf8')
  expect(index).toContain('<link rel="manifest" href="./manifest.webmanifest" />')
  expect(index).toContain(`<title>${custom ? 'Harnessy' : build.DSH_CLIENT_TITLE ?? 'DSH Local Build'}</title>`)
  expect(index).toContain(`href="${custom ? '/harnessy.png' : './favicon.svg'}"`)
  expect(index).toContain(`type="${custom ? 'image/png' : 'image/svg+xml'}"`)

  const manifest: unknown = JSON.parse(await readFile(join(DIST_ROOT, 'manifest.webmanifest'), 'utf8'))
  // No `id`: a browser resolves an explicit `id` against the start URL's origin,
  // so only an absent `id`, which defaults to the resolved `start_url`, gives
  // each mount its own identity. `public-mount.e2e.ts` reads the resolved form.
  expect(manifest).toEqual({
    name: build.DSH_CLIENT_PRODUCT_NAME ?? 'DeepSeek Harness',
    short_name: build.DSH_CLIENT_MANIFEST_SHORT_NAME ?? 'DSH',
    start_url: './',
    scope: './',
    display: 'standalone',
    icons: [
      ...[192, 512].map(size => ({
        src: `${custom ? 'harnessy' : 'dsh'}-mobile-${size}.png`,
        sizes: `${size}x${size}`, type: 'image/png', purpose: 'any',
      })),
      ...custom ? [] : [{ src: 'favicon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' }],
    ],
  })
  for (const size of [192, 512]) {
    const png = await readFile(join(DIST_ROOT, `${custom ? 'harnessy' : 'dsh'}-mobile-${size}.png`))
    expect(png.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a')
    expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([size, size])
  }
})

it('ships fixed-color favicons selected by document media queries', async () => {
  const index = await readFile(join(DIST_ROOT, 'index.html'), 'utf8')
  const mime = custom ? 'image/png' : 'image/svg+xml'
  expect(index).toContain(`<link rel="icon" type="${mime}" href="${custom ? '/harnessy.png' : './favicon-dark.svg'}" media="(prefers-color-scheme: dark)" />`)
  expect(index).toContain(`<link rel="icon" type="${mime}" href="${custom ? '/harnessy.png' : './favicon.svg'}" media="(prefers-color-scheme: light)" />`)
  const light = await readFile(join(DIST_ROOT, 'favicon.svg'), 'utf8')
  const dark = await readFile(join(DIST_ROOT, 'favicon-dark.svg'), 'utf8')
  expect(light).not.toContain('<style>')
  expect(light).toContain('fill="#000"')
  expect(dark).toContain('fill="#fff"')
  expect(dark.replace('fill="#fff"', 'fill="#000"')).toBe(light)
})
