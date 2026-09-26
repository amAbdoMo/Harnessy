import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolveDesktopPaths } from '../src/paths.ts'

describe('desktop paths', () => {
  it('keeps the installed profile under the Harness home by default', () => {
    const home = resolve('C:/Harnessy/Home')
    expect(resolveDesktopPaths(home, undefined)).toEqual({
      profile: join(home, 'profiles', 'desktop'),
      lock: join(home, 'profiles', 'desktop', 'lock'),
    })
  })

  it('allows development to isolate executable profile files from shared user data', () => {
    const home = resolve('C:/Harnessy/Home')
    const profile = resolve('D:/Harnessy/Development/Profile')
    expect(resolveDesktopPaths(home, profile)).toEqual({ profile, lock: join(profile, 'lock') })
  })

  it('rejects a relative profile override', () => {
    expect(() => resolveDesktopPaths(resolve('C:/Harnessy/Home'), 'relative/profile'))
      .toThrow('DSH_DESKTOP_PROFILE_DIR must be an absolute path')
  })
})
