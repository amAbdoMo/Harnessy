import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolveDevelopmentProductPaths } from '../scripts/dev.ts'

describe('Harnessy development product paths', () => {
  it('uses the installed product data root by default', () => {
    const local = resolve('C:/Users/example/AppData/Local')
    const product = resolveDevelopmentProductPaths({ LOCALAPPDATA: local })
    expect(product).toMatchObject({
      data: join(local, 'CustomHarness'),
      home: join(local, 'CustomHarness', 'Harness'),
      agents: join(local, 'CustomHarness', 'Agents'),
      logs: join(local, 'CustomHarness', 'Logs'),
      cache: join(local, 'CustomHarness', 'Cache'),
      userData: join(local, 'CustomHarness', 'Cache', 'DesktopUserData'),
    })
    expect(product.profile).toMatch(/[\\/]apps[\\/]desktop[\\/]\.desktop-build[\\/]development[\\/]Harness[\\/]profiles[\\/]desktop$/u)
  })

  it('honors explicit Harness and Electron data overrides', () => {
    const data = resolve('D:/Harnessy')
    const home = resolve('D:/Harnessy-home')
    const userData = resolve('D:/Harnessy-browser')
    const profile = resolve('D:/Harnessy-profile')
    expect(resolveDevelopmentProductPaths({
      CUSTOM_HARNESS_DATA_DIR: data,
      DSH_HOME: home,
      DSH_DESKTOP_USER_DATA_DIR: userData,
      DSH_DESKTOP_PROFILE_DIR: profile,
    })).toMatchObject({ data, home, userData, profile })
  })

  it('rejects a relative development profile override', () => {
    expect(() => resolveDevelopmentProductPaths({
      LOCALAPPDATA: resolve('C:/Users/example/AppData/Local'),
      DSH_DESKTOP_PROFILE_DIR: 'relative/profile',
    })).toThrow('DSH_DESKTOP_PROFILE_DIR must be an absolute path')
  })
})
