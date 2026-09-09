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
  expect(index).toContain(`<title>${custom ? 'Custom Harness' : build.DSH_CLIENT_TITLE ?? 'DSH Local Build'}</title>`)
  expect(index).toContain(`href="${custom ? '/custom-harness.svg' : '/favicon.svg'}"`)

  const manifest: unknown = JSON.parse(await readFile(join(DIST_ROOT, 'manifest.webmanifest'), 'utf8'))
  expect(manifest).toEqual({
    id: '/',
    name: custom ? 'Custom Harness' : 'DeepSeek Harness',
    short_name: custom ? 'Harness' : 'DSH',
    start_url: '/',
    scope: '/',
    display: 'fullscreen',
    icons: [{
      src: custom ? '/custom-harness.svg' : '/favicon.svg',
      sizes: 'any',
      type: 'image/svg+xml',
      purpose: 'any',
    }],
  })
})

it('ships a favicon that switches to a light mark under dark color scheme', async () => {
  const favicon = await readFile(join(DIST_ROOT, custom ? 'custom-harness.svg' : 'favicon.svg'), 'utf8')
  if (custom) {
    expect(favicon).toContain('viewBox="0 0 64 64"')
    expect(favicon).toMatch(/@media\s*\(prefers-color-scheme:\s*dark\)/i)
    expect(favicon).toContain('#5747e6')
    expect(favicon).toContain('#aa9fff')
    return
  }
  // The light fill must live inside the dark-scheme media query, so the icon
  // stays black in light mode and only turns white under a dark scheme.
  expect(favicon).toMatch(/@media \(prefers-color-scheme: dark\)\s*{\s*path\s*{[^}]*fill:\s*#fff/i)
  expect(favicon).toContain('fill="#000"')
})
