import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { createElectronBuilderConfig } from '../scripts/electron-builder-config.mjs'

it('packages the original-logo ICO for Windows executable and native window icons', () => {
  const config = createElectronBuilderConfig({
    DSH_DESKTOP_APP_ID: 'com.example.icon-test',
    DSH_DESKTOP_AUTO_UPDATE_ENV: 'production',
    DSH_DESKTOP_MANDATORY_UPDATE_PROD_ORIGIN: 'https://policy.example.com',
    DSH_DESKTOP_TARGET_PLATFORM: 'win32',
    DSH_DESKTOP_TARGET_ARCH: 'x64',
    DSH_DESKTOP_RELEASE_UNSIGNED: '1',
  }, 'win32', 'x64')
  const application = config.extraResources.find(resource => resource.to === 'icon.ico')
  const tray = config.extraResources.find(resource => resource.to === 'tray.ico')
  expect(application!.from).toBe(config.win.icon)
  expect(readFileSync(application!.from)).toEqual(readFileSync(new URL('../resources/app-windows.ico', import.meta.url)))
  expect(readFileSync(tray!.from)).toEqual(readFileSync(new URL('../resources/tray-windows.ico', import.meta.url)))
}, 30_000)
