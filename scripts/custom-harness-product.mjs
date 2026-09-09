import { isAbsolute, resolve } from 'node:path'

/** Product identity selected for the independently branded Custom Harness build. */
export const CUSTOM_HARNESS_PRODUCT = Object.freeze({
  displayName: 'Custom Harness',
  slug: 'custom-harness',
  windowsAppId: 'com.amabdmo.customharness',
  executableName: 'CustomHarness',
  installerName: 'CustomHarness-Setup',
  protocol: 'custom-harness',
  dataDirectoryName: 'CustomHarness',
  harnessHomeDirectoryName: 'Harness',
  agentsHomeDirectoryName: 'Agents',
  logDirectoryName: 'Logs',
  cacheDirectoryName: 'Cache',
  desktopUserDataDirectoryName: 'DesktopUserData',
  desktopProfileBundles: Object.freeze([
    '@deepseek-ai/dsh-base',
    '@deepseek-ai/dsh-web-app',
    '@deepseek-ai/dsh-custom-harness',
  ]),
  automaticUpdates: false,
  productUrl: 'https://github.com/amAbdoMo/Harnessy',
  supportUrl: 'https://github.com/amAbdoMo/Harnessy/issues',
  manifestShortName: 'Harness',
  iconPath: '/custom-harness.svg',
})

/** Public build values embedded into the Custom Harness browser artifacts. */
export const CUSTOM_HARNESS_CLIENT_BUILD_ENVIRONMENT = Object.freeze({
  DSH_CLIENT_BUILD_PROFILE: CUSTOM_HARNESS_PRODUCT.slug,
  DSH_CLIENT_TITLE: CUSTOM_HARNESS_PRODUCT.displayName,
  DSH_CLIENT_PRODUCT_NAME: CUSTOM_HARNESS_PRODUCT.displayName,
  DSH_CLIENT_PRODUCT_SLUG: CUSTOM_HARNESS_PRODUCT.slug,
  DSH_CLIENT_PRODUCT_URL: CUSTOM_HARNESS_PRODUCT.productUrl,
  DSH_CLIENT_SUPPORT_URL: CUSTOM_HARNESS_PRODUCT.supportUrl,
  DSH_CLIENT_MANIFEST_SHORT_NAME: CUSTOM_HARNESS_PRODUCT.manifestShortName,
  DSH_CLIENT_ICON_PATH: CUSTOM_HARNESS_PRODUCT.iconPath,
})

function absolutePath(value, label) {
  if (!isAbsolute(value)) throw new Error(`${label} must be an absolute path`)
  return resolve(value)
}

function optionalAbsolutePath(environment, name, fallback) {
  const configured = environment[name]
  if (configured === undefined || configured.trim() === '') return fallback
  return absolutePath(configured, name)
}

function desktopState(data, environment = {}) {
  const home = optionalAbsolutePath(
    environment,
    'CUSTOM_HARNESS_HOME',
    optionalAbsolutePath(environment, 'DSH_HOME', resolve(data, CUSTOM_HARNESS_PRODUCT.harnessHomeDirectoryName)),
  )
  const agents = optionalAbsolutePath(
    environment,
    'CUSTOM_HARNESS_AGENTS_DIR',
    optionalAbsolutePath(environment, 'DSH_AGENTS_HOME', resolve(data, CUSTOM_HARNESS_PRODUCT.agentsHomeDirectoryName)),
  )
  const logs = optionalAbsolutePath(
    environment,
    'CUSTOM_HARNESS_LOG_DIR',
    resolve(data, CUSTOM_HARNESS_PRODUCT.logDirectoryName),
  )
  const cache = optionalAbsolutePath(
    environment,
    'CUSTOM_HARNESS_CACHE_DIR',
    resolve(data, CUSTOM_HARNESS_PRODUCT.cacheDirectoryName),
  )
  return Object.freeze({
    data,
    home,
    agents,
    logs,
    cache,
    userData: resolve(cache, CUSTOM_HARNESS_PRODUCT.desktopUserDataDirectoryName),
  })
}

/** Resolve immutable installed-app state under the product-owned local application data root. */
export function resolvePackagedCustomHarnessDesktopState(localApplicationData) {
  const local = absolutePath(localApplicationData, 'local application data')
  return desktopState(resolve(local, CUSTOM_HARNESS_PRODUCT.dataDirectoryName))
}

/** Resolve disposable development state while honoring explicit absolute developer overrides. */
export function resolveDevelopmentCustomHarnessDesktopState(defaultData, environment = process.env) {
  const fallback = absolutePath(defaultData, 'development data root')
  const data = optionalAbsolutePath(environment, 'CUSTOM_HARNESS_DATA_DIR', fallback)
  return desktopState(data, environment)
}
