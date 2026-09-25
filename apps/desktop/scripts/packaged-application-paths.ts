/** Resolve assembled Desktop paths from the product identity used by electron-builder. */

import { join } from 'node:path'
import { CUSTOM_HARNESS_PRODUCT } from '../../../scripts/custom-harness-product.ts'

/** Assembled application paths used by packaged runtime verification. */
export interface PackagedApplicationPaths {
  readonly application: string
  readonly resources: string
  readonly executable: string
}

/**
 * Resolve the application, resources, and executable paths for an assembled Desktop target.
 * @param artifacts Artifact directory that contains the unpacked application.
 * @param target Desktop release target.
 * @returns Assembled paths for runtime verification.
 */
export function packagedApplicationPaths(
  artifacts: string,
  target: 'mac-arm64' | 'mac-x64' | 'win-x64',
): PackagedApplicationPaths {
  const windows = target === 'win-x64'
  const application = windows
    ? join(artifacts, 'win-unpacked')
    : join(
      artifacts,
      target === 'mac-arm64' ? 'mac-arm64' : 'mac',
      `${CUSTOM_HARNESS_PRODUCT.displayName}.app`,
      'Contents',
    )
  return {
    application,
    resources: join(application, windows ? 'resources' : 'Resources'),
    executable: windows
      ? join(application, `${CUSTOM_HARNESS_PRODUCT.executableName}.exe`)
      : join(application, 'MacOS', CUSTOM_HARNESS_PRODUCT.executableName),
  }
}
