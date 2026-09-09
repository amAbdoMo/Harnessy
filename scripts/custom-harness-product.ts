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
