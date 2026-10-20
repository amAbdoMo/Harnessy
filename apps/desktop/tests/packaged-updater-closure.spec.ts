import { fileURLToPath } from 'node:url'
import { expect, it, vi } from 'vitest'
import { updaterRuntimeClosure } from '../scripts/updater-runtime-closure.mjs'

const { officePackageDirectories } = vi.hoisted(() => ({
  officePackageDirectories: vi.fn(async () => []),
}))
const { readAsar } = vi.hoisted(() => ({ readAsar: vi.fn(async () => archive) }))
const archive = { getFile: (path: string) => (path.endsWith('package.json') ? { size: 1 } : undefined) }

vi.mock('../../../scripts/libreoffice-packages.mjs', () => ({ officePackageDirectories }))
// The hook imports the built tree, which a clean checkout has not produced.
vi.mock('/apps/desktop/lib/types/runtime-tree.js', () => ({ verifyDesktopRuntime: async () => undefined }))
vi.mock('../scripts/windows-asar-unpack.mjs', async importOriginal => ({
  ...await importOriginal<typeof import('../scripts/windows-asar-unpack.mjs')>(),
  prepareWindowsAsarUnpack: async () => [],
  verifyWindowsAsarUnpack: async () => undefined,
}))
vi.mock('app-builder-lib/out/asar/asar.js', () => ({ readAsar }))

const ENVIRONMENT = {
  DSH_DESKTOP_APP_ID: 'com.example.installer',
  DSH_DESKTOP_TARGET_PLATFORM: 'win32',
  DSH_DESKTOP_TARGET_ARCH: 'x64',
  DSH_DESKTOP_UNSIGNED: '1',
  DSH_DESKTOP_MANDATORY_UPDATE_TEST_ORIGIN: 'https://policy.example.com',
  DSH_DESKTOP_MANDATORY_UPDATE_CONFIG: JSON.stringify({ allowedAuthOrigins: ['https://login.example.com'] }),
  DOWNLOAD_TEST_ORIGIN: 'https://desktop-updates.example.com',
  DOWNLOAD_TEST_RELEASE_ID: '0123456789abcdef0123456789abcdef',
}
const APP_DIRECTORY = fileURLToPath(new URL('..', import.meta.url))

it('packages the auto-updater runtime closure and rejects an incomplete archive', async () => {
  const { createElectronBuilderConfig } = await import('../scripts/electron-builder-config.mjs')
  const config = createElectronBuilderConfig(ENVIRONMENT, 'win32', 'x64')
  const context = {
    appOutDir: 'out',
    packager: {
      config: { files: [] },
      info: { appDir: APP_DIRECTORY },
      getResourcesDir: () => 'out/resources',
    },
  }
  await config.beforePack(context as never)
  const closure = updaterRuntimeClosure(APP_DIRECTORY)
  const staged = context.packager.config.files.filter((file: { to?: string }) => (
    typeof file === 'object' && typeof file.to === 'string' && file.to.startsWith('node_modules/')
  ))
  expect(staged.map((file: { to: string }) => file.to)).toEqual(
    closure.map(member => `node_modules/${member.name}`))
  await expect(config.afterPack(context as never)).resolves.toBeUndefined()
  readAsar.mockResolvedValueOnce({ getFile: (path: string) => (path.includes('debug') ? undefined : { size: 1 }) })
  await expect(config.afterPack(context as never)).rejects.toThrow(/missing .*debug/u)
}, 30_000)
