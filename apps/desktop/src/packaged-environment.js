import { isAbsolute, resolve } from 'node:path'

const PRODUCT_NAME = 'Custom Harness'
const PRODUCT_DIRECTORY = 'CustomHarness'
const PROFILE = 'custom-harness'
const APP_ID = 'com.amabdmo.customharness'

function absoluteOverride(environment, name, fallback) {
  const configured = environment[name]
  if (configured === undefined || configured.trim() === '') return fallback
  if (!isAbsolute(configured)) throw new Error(`${name} must be an absolute path`)
  return resolve(configured)
}

/** Build the environment used by the installed Electron entry point. */
export function packagedDesktopEnvironment(resourcesPath, environment = process.env) {
  if (!isAbsolute(resourcesPath)) throw new Error('Electron resourcesPath must be absolute')
  const localAppData = environment.LOCALAPPDATA
  if (localAppData === undefined || localAppData.trim() === '' || !isAbsolute(localAppData)) {
    throw new Error('Custom Harness requires an absolute LOCALAPPDATA path')
  }

  const productData = absoluteOverride(
    environment,
    'CUSTOM_HARNESS_DATA_DIR',
    resolve(localAppData, PRODUCT_DIRECTORY),
  )
  const home = absoluteOverride(environment, 'CUSTOM_HARNESS_HOME', resolve(productData, 'Harness'))
  const agents = absoluteOverride(environment, 'CUSTOM_HARNESS_AGENTS_DIR', resolve(productData, 'Agents'))
  const logs = absoluteOverride(environment, 'CUSTOM_HARNESS_LOG_DIR', resolve(productData, 'Logs'))
  const cache = absoluteOverride(environment, 'CUSTOM_HARNESS_CACHE_DIR', resolve(productData, 'Cache'))
  const runtime = resolve(resourcesPath, 'runtime')
  const dshRoot = resolve(resourcesPath, 'dsh')

  return {
    ...environment,
    DSH_HOME: home,
    DSH_AGENTS_HOME: agents,
    CUSTOM_HARNESS_DATA_DIR: productData,
    CUSTOM_HARNESS_AGENTS_DIR: agents,
    CUSTOM_HARNESS_LOG_DIR: logs,
    CUSTOM_HARNESS_CACHE_DIR: cache,
    CUSTOM_HARNESS_PRODUCT_NAME: PRODUCT_NAME,
    CUSTOM_HARNESS_DESKTOP_APP_ID: APP_ID,
    CUSTOM_HARNESS_DESKTOP_PROFILE: PROFILE,
    CUSTOM_HARNESS_DESKTOP_NODE_EXECUTABLE: resolve(runtime, 'node.exe'),
    CUSTOM_HARNESS_DESKTOP_DSH_ENTRY: resolve(dshRoot, 'lib', 'bin.js'),
    CUSTOM_HARNESS_DESKTOP_JOB_LAUNCHER: resolve(resourcesPath, 'windows-job-launcher.exe'),
    CUSTOM_HARNESS_DESKTOP_WORKING_DIRECTORY: dshRoot,
    CUSTOM_HARNESS_DESKTOP_USER_DATA: resolve(cache, 'DesktopUserData'),
    CUSTOM_HARNESS_DESKTOP_LOG_DIR: logs,
    CUSTOM_HARNESS_DESKTOP_ICON: resolve(resourcesPath, 'custom-harness.png'),
  }
}
