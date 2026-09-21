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

  it.each([
    ['darwin', true],
    ['linux', true],
    ['win32', false],
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
