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
  expect(index).toContain(`href="${custom ? '/harnessy.png' : '/favicon.svg'}"`)
  expect(index).toContain(`type="${custom ? 'image/png' : 'image/svg+xml'}"`)

  const manifest: unknown = JSON.parse(await readFile(join(DIST_ROOT, 'manifest.webmanifest'), 'utf8'))
  expect(manifest).toEqual({
    id: '/',
    name: custom ? 'Harnessy' : 'DeepSeek Harness',
    short_name: custom ? 'Harnessy' : 'DSH',
    start_url: '/',
    scope: '/',
    display: 'fullscreen',
    icons: [{
      src: custom ? '/harnessy.png' : '/favicon.svg',
      sizes: custom ? '1254x1254' : 'any',
      type: custom ? 'image/png' : 'image/svg+xml',
      purpose: 'any',
    }],
  })
})

it('ships the selected product favicon', async () => {
  if (custom) {
    const favicon = await readFile(join(DIST_ROOT, 'harnessy.png'))
    expect(favicon.subarray(1, 4).toString('ascii')).toBe('PNG')
    return
  }
  const favicon = await readFile(join(DIST_ROOT, 'favicon.svg'), 'utf8')
  // The light fill must live inside the dark-scheme media query, so the icon
  // stays black in light mode and only turns white under a dark scheme.
  expect(favicon).toMatch(/@media \(prefers-color-scheme: dark\)\s*{\s*path\s*{[^}]*fill:\s*#fff/i)
  expect(favicon).toContain('fill="#000"')
})
