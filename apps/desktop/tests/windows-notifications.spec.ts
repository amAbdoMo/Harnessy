import { describe, expect, it } from 'vitest'
import { windowsNotificationShortcut } from '../src/windows-notifications.ts'

describe('Windows notification shortcut', () => {
  it('registers the packaged executable and application id in the Start menu', () => {
    expect(windowsNotificationShortcut({
      platform: 'win32',
      packaged: true,
      roamingApplicationData: 'C:\\Users\\Person\\AppData\\Roaming',
      executable: 'D:\\Harnessy\\Harnessy.exe',
      displayName: 'Harnessy',
      applicationId: 'com.amabdmo.customharness',
    })).toEqual({
      path: 'C:\\Users\\Person\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Harnessy.lnk',
      details: {
        target: 'D:\\Harnessy\\Harnessy.exe',
        icon: 'D:\\Harnessy\\Harnessy.exe',
        iconIndex: 0,
        description: 'Harnessy',
        appUserModelId: 'com.amabdmo.customharness',
      },
    })
  })

  it('relaunches an unpackaged executable with the arguments that reopen the application', () => {
    expect(windowsNotificationShortcut({
      platform: 'win32',
      packaged: false,
      roamingApplicationData: 'C:\\Users\\Person\\AppData\\Roaming',
      executable: 'A:\\Repository\\node_modules\\electron\\dist\\electron.exe',
      displayName: 'Harnessy',
      applicationId: 'com.amabdmo.customharness',
      launchArguments: '--user-data-dir="C:\\cache\\DesktopUserData" "A:\\Repository\\apps\\desktop"',
    })).toEqual({
      path: 'C:\\Users\\Person\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Harnessy.lnk',
      details: {
        target: 'A:\\Repository\\node_modules\\electron\\dist\\electron.exe',
        icon: 'A:\\Repository\\node_modules\\electron\\dist\\electron.exe',
        iconIndex: 0,
        description: 'Harnessy',
        appUserModelId: 'com.amabdmo.customharness',
        args: '--user-data-dir="C:\\cache\\DesktopUserData" "A:\\Repository\\apps\\desktop"',
      },
    })
  })

  it.each([
    ['darwin', true],
    ['linux', true],
  ] as const)('does not create a shortcut on %s when packaged is %s', (platform, packaged) => {
    expect(windowsNotificationShortcut({
      platform,
      packaged,
      roamingApplicationData: '/roaming',
      executable: '/app',
      displayName: 'Harnessy',
      applicationId: 'com.amabdmo.customharness',
    })).toBeUndefined()
  })
})
