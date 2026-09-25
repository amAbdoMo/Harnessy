import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { packagedApplicationPaths } from '../scripts/packaged-application-paths.ts'

describe('packaged application paths', () => {
  it('uses the shared product executable for Windows', () => {
    const application = join('release', 'win-unpacked')
    expect(packagedApplicationPaths('release', 'win-x64')).toEqual({
      application,
      resources: join(application, 'resources'),
      executable: join(application, 'Harnessy.exe'),
    })
  })

  it.each([
    ['mac-arm64', 'mac-arm64'],
    ['mac-x64', 'mac'],
  ] as const)('uses the shared product bundle for %s', (target, outputDirectory) => {
    const application = join('release', outputDirectory, 'Harnessy.app', 'Contents')
    expect(packagedApplicationPaths('release', target)).toEqual({
      application,
      resources: join(application, 'Resources'),
      executable: join(application, 'MacOS', 'Harnessy'),
    })
  })
})
