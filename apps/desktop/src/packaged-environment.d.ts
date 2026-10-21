/** Installed Desktop paths resolved independently of the installation directory. */
export type PackagedDesktopEnvironment = NodeJS.ProcessEnv & Record<
  | 'DSH_HOME' | 'DSH_AGENTS_HOME' | 'CUSTOM_HARNESS_DATA_DIR' | 'CUSTOM_HARNESS_AGENTS_DIR'
  | 'CUSTOM_HARNESS_LOG_DIR' | 'CUSTOM_HARNESS_CACHE_DIR' | 'CUSTOM_HARNESS_PRODUCT_NAME'
  | 'CUSTOM_HARNESS_DESKTOP_APP_ID' | 'CUSTOM_HARNESS_DESKTOP_PROFILE'
  | 'CUSTOM_HARNESS_DESKTOP_NODE_EXECUTABLE' | 'CUSTOM_HARNESS_DESKTOP_DSH_ENTRY'
  | 'CUSTOM_HARNESS_DESKTOP_JOB_LAUNCHER' | 'CUSTOM_HARNESS_DESKTOP_WORKING_DIRECTORY'
  | 'CUSTOM_HARNESS_DESKTOP_USER_DATA' | 'CUSTOM_HARNESS_DESKTOP_LOG_DIR' | 'CUSTOM_HARNESS_DESKTOP_ICON',
  string
>

/**
 * Resolve installed user-data paths and version-owned runtime paths.
 * @param resourcesPath - Absolute application resources directory.
 * @param environment - Parent environment with an absolute LOCALAPPDATA directory.
 * @returns Environment retaining parent values and assigning resolved Desktop paths.
 */
export function packagedDesktopEnvironment(
  resourcesPath: string,
  environment?: NodeJS.ProcessEnv,
): PackagedDesktopEnvironment
