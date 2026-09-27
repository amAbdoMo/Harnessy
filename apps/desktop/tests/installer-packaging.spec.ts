import { tmpdir } from 'node:os'
import { readFileSync } from 'node:fs'
import { Arch, Platform } from 'electron-builder'
import { Packager } from 'app-builder-lib'
import { describe, expect, it, vi } from 'vitest'
import { CUSTOM_HARNESS_PRODUCT } from '../../../scripts/custom-harness-product.mjs'

const { execute } = vi.hoisted(() => ({ execute: vi.fn(async () => undefined) }))
vi.mock('node:child_process', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:child_process')>()
  const { promisify } = await import('node:util')
  return { ...original, execFile: Object.assign(vi.fn(), { [promisify.custom]: execute }) }
})

/** Production release settings for an unsigned Windows release, which carries no certificate field. */
function releaseUnsignedEnvironment(): NodeJS.ProcessEnv {
  return {
    DSH_DESKTOP_APP_ID: 'com.example.installer',
    DSH_DESKTOP_AUTO_UPDATE_ENV: 'production',
    DSH_DESKTOP_MANDATORY_UPDATE_PROD_ORIGIN: 'https://policy.example.com',
    DSH_DESKTOP_TARGET_PLATFORM: 'win32',
    DSH_DESKTOP_TARGET_ARCH: 'x64',
    DSH_DESKTOP_RELEASE_UNSIGNED: '1',
  }
}

describe('installer preparation preserves application dependencies', () => {
  it.each(['win32', 'darwin'] as const)('rejects a missing production policy before signing on %s', async (platform) => {
    const { createElectronBuilderConfig } = await import('../scripts/electron-builder-config.mjs')
    expect(() => createElectronBuilderConfig({ DSH_DESKTOP_APP_ID: 'com.example.installer',
      DSH_DESKTOP_AUTO_UPDATE_ENV: 'production',
      DSH_DESKTOP_MANDATORY_UPDATE_TEST_ORIGIN: 'https://test.example.com',
    }, platform, 'x64')).toThrow('DSH_DESKTOP_MANDATORY_UPDATE_PROD_ORIGIN')
  })
  it.each(['win32', 'darwin'] as const)('keeps electron-builder responsible for node_modules on %s', async (platform) => {
    execute.mockClear()
    const env = {
      DSH_DESKTOP_APP_ID: 'com.example.installer',
      DSH_DESKTOP_MANDATORY_UPDATE_TEST_ORIGIN: 'https://policy.example.com',
      DSH_DESKTOP_MANDATORY_UPDATE_CONFIG: JSON.stringify({ allowedAuthOrigins: ['https://login.example.com'] }),
      DSH_DESKTOP_TARGET_PLATFORM: platform,
      DSH_DESKTOP_TARGET_ARCH: 'x64',
      DSH_DESKTOP_UNSIGNED: platform === 'win32' ? '1' : '0',
      DSH_DESKTOP_MACOS_SIGNING_IDENTITY: 'Example Company (TEAMID1234)',
      DSH_DESKTOP_MACOS_TEAM_ID: 'TEAMID1234',
      APPLE_KEYCHAIN_PROFILE: 'installer-test',
      DOWNLOAD_TEST_ORIGIN: 'https://desktop-updates.example.com', DOWNLOAD_TEST_RELEASE_ID: '0123456789abcdef0123456789abcdef',
    }
    for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value)
    try {
      const { createElectronBuilderConfig } = await import('../electron-builder.config.mjs')
      const config = createElectronBuilderConfig(env, platform, 'x64')
      const aboutIcon = config.extraResources.find(resource => resource.to === 'icon.png')
      expect(aboutIcon).toBeDefined()
      expect(readFileSync(aboutIcon!.from)).toEqual(readFileSync(new URL('../resources/icon-windows.png', import.meta.url)))
      // Only the Windows package carries the tray bitmaps; macOS keeps the Dock.
      const trayIcon = config.extraResources.find(resource => resource.to === 'tray.ico')
      if (platform === 'win32') {
        expect(readFileSync(trayIcon!.from)).toEqual(readFileSync(new URL('../resources/tray-windows.ico', import.meta.url)))
      } else {
        expect(trayIcon).toBeUndefined()
      }
      const packager = new Packager({ projectDir: tmpdir() })
      // A foreign source-build target avoids rebuilding modules; the real dependency ownership decision still runs.
      Object.defineProperties(packager, {
        config: { value: { beforeBuild: config.beforeBuild, buildDependenciesFromSource: true } },
        framework: { value: { isNpmRebuildRequired: true, version: '42.0.0' } },
        appInfo: { value: { type: 'module' } },
      })
      vi.spyOn(packager, 'getWorkspaceRoot').mockResolvedValue(tmpdir())
      await packager.installAppDependencies(process.platform === 'win32' ? Platform.LINUX : Platform.WINDOWS, Arch.x64)
      expect(packager.areNodeModulesHandledExternally).toBe(false)
      expect(execute).toHaveBeenCalledTimes(platform === 'win32' ? 1 : 0)
    } finally {
      vi.unstubAllEnvs()
      vi.restoreAllMocks()
    }
  })

  it('names unsigned Windows artifacts so they cannot pass for release builds', async () => {
    const { createElectronBuilderConfig } = await import('../scripts/electron-builder-config.mjs')
    const config = createElectronBuilderConfig({
      DSH_DESKTOP_APP_ID: 'com.example.installer',
      DSH_DESKTOP_MANDATORY_UPDATE_TEST_ORIGIN: 'https://policy.example.com',
      DSH_DESKTOP_MANDATORY_UPDATE_CONFIG: JSON.stringify({ allowedAuthOrigins: ['https://login.example.com'] }),
      DSH_DESKTOP_TARGET_PLATFORM: 'win32',
      DSH_DESKTOP_TARGET_ARCH: 'x64',
      DSH_DESKTOP_UNSIGNED: '1',
    }, 'win32', 'x64')
    expect(config.artifactName).toBe(`${CUSTOM_HARNESS_PRODUCT.installerName}-\${version}-\${os}-\${arch}-unsigned.\${ext}`)
  })

  it('packages the release-unsigned installer under the release name with the GitHub production feed', async () => {
    const { createElectronBuilderConfig } = await import('../scripts/electron-builder-config.mjs')
    const config = createElectronBuilderConfig(releaseUnsignedEnvironment(), 'win32', 'x64')
    // No suffix and the normal artifact directory: these bytes are the release, not a local build.
    expect(config.artifactName).toBe(`${CUSTOM_HARNESS_PRODUCT.installerName}-\${version}-\${os}-\${arch}.\${ext}`)
    expect(config.directories.output.replaceAll('\\', '/')).toMatch(/\/targets\/win-x64\/artifacts$/u)
    expect(config).toMatchObject({
      // Without a publisher name electron-updater verifies the download through latest.yml's SHA-512.
      win: { forceCodeSigning: false, verifyUpdateCodeSignature: false, signtoolOptions: { sign: undefined, publisherName: undefined } },
      publish: [{ provider: 'github', owner: CUSTOM_HARNESS_PRODUCT.updateRepository.owner,
        repo: CUSTOM_HARNESS_PRODUCT.updateRepository.repo, channel: 'latest', releaseType: 'release' }],
      extraMetadata: { dshDesktopUpdateEnvironment: 'production' },
    })
  })

  it('refuses a release-unsigned build that would not reach the GitHub production feed', async () => {
    const { createElectronBuilderConfig } = await import('../scripts/electron-builder-config.mjs')
    const release = releaseUnsignedEnvironment()
    expect(() => createElectronBuilderConfig({ ...release, DSH_DESKTOP_TARGET_PLATFORM: 'darwin', DSH_DESKTOP_TARGET_ARCH: 'arm64' }, 'darwin', 'arm64'))
      .toThrow(/release-unsigned builds require Windows/u)
    expect(() => createElectronBuilderConfig({ ...release, DSH_DESKTOP_RELEASE_UNSIGNED: 'yes' }, 'win32', 'x64'))
      .toThrow(/DSH_DESKTOP_RELEASE_UNSIGNED must be 0 or 1/u)
    expect(() => createElectronBuilderConfig({ ...release, DSH_DESKTOP_UNSIGNED: '1' }, 'win32', 'x64'))
      .toThrow(/local and release unsigned modes are mutually exclusive/u)
    expect(() => createElectronBuilderConfig({
      ...release,
      DSH_DESKTOP_AUTO_UPDATE_ENV: 'test',
      DSH_DESKTOP_MANDATORY_UPDATE_TEST_ORIGIN: 'https://policy.example.com',
      DSH_DESKTOP_MANDATORY_UPDATE_CONFIG: JSON.stringify({ allowedAuthOrigins: ['https://login.example.com'] }),
      DOWNLOAD_TEST_ORIGIN: 'https://updates.example.com',
      DOWNLOAD_TEST_RELEASE_ID: '0123456789abcdef0123456789abcdef',
    }, 'win32', 'x64')).toThrow(/production GitHub update feed/u)
  })

  it('packages every preload entry point the shell loads', async () => {
    const { readdirSync, readFileSync } = await import('node:fs')
    const sourceDirectory = new URL('../src/', import.meta.url)
    const referenced = new Set<string>()
    for (const entry of readdirSync(sourceDirectory, { withFileTypes: true })) {
      if (!entry.isFile()) continue
      for (const match of readFileSync(new URL(entry.name, sourceDirectory), 'utf8').matchAll(/preload-[a-z-]+\.cjs/gu)) referenced.add(match[0])
    }
    expect(referenced.size).toBeGreaterThan(0)
    const { createElectronBuilderConfig } = await import('../scripts/electron-builder-config.mjs')
    const config = createElectronBuilderConfig({
      DSH_DESKTOP_APP_ID: 'com.example.installer',
      DSH_DESKTOP_AUTO_UPDATE_ENV: 'production',
      DSH_DESKTOP_MANDATORY_UPDATE_TEST_ORIGIN: 'https://harness-test.deepseek.com',
      DSH_DESKTOP_MANDATORY_UPDATE_PROD_ORIGIN: 'https://policy.example.com',
      DSH_DESKTOP_MACOS_SIGNING_IDENTITY: 'Example Company (TEAMID1234)',
      DSH_DESKTOP_MACOS_TEAM_ID: 'TEAMID1234',
      APPLE_KEYCHAIN_PROFILE: 'installer-test',
    }, 'darwin', 'arm64')
    const packaged = new Set(config.files.filter((entry): entry is string => typeof entry === 'string'))
    for (const name of referenced) expect(packaged.has(`lib/${name}`)).toBe(true)
  })
})
