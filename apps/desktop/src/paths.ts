/** Filesystem ownership for the Electron-managed desktop installation. */

import { isAbsolute, join, resolve } from 'node:path'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'

/** Stable desktop installation paths under the shared Harness home. */
export interface DesktopPaths {
  readonly profile: string
  readonly lock: string
}

/**
 * Resolve every Electron-owned path without changing the shared data roots.
 * @param dshHome - Harness home shared with npm-installed dsh.
 * @param profileOverride - Optional development-only profile directory.
 * @returns immutable desktop path set.
 */
export function resolveDesktopPaths(
  dshHome: string = resolveDshHome(),
  profileOverride?: string,
): DesktopPaths {
  if (profileOverride !== undefined && !isAbsolute(profileOverride)) {
    throw new Error('dsh desktop: DSH_DESKTOP_PROFILE_DIR must be an absolute path')
  }
  const profile = profileOverride === undefined
    ? join(dshHome, 'profiles', 'desktop')
    : resolve(profileOverride)
  return {
    profile,
    lock: join(profile, 'lock'),
  }
}
