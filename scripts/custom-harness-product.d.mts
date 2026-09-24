export interface CustomHarnessProduct {
  readonly displayName: 'Harnessy'
  readonly slug: 'custom-harness'
  readonly windowsAppId: 'com.amabdmo.customharness'
  readonly executableName: 'Harnessy'
  readonly installerName: 'Harnessy-Setup'
  readonly protocol: 'custom-harness'
  readonly dataDirectoryName: 'CustomHarness'
  readonly harnessHomeDirectoryName: 'Harness'
  readonly agentsHomeDirectoryName: 'Agents'
  readonly logDirectoryName: 'Logs'
  readonly cacheDirectoryName: 'Cache'
  readonly desktopUserDataDirectoryName: 'DesktopUserData'
  readonly desktopProfileBundles: readonly [
    '@deepseek-ai/dsh-base',
    '@deepseek-ai/dsh-web-app',
    '@deepseek-ai/dsh-custom-harness',
  ]
  readonly automaticUpdates: false
  readonly productUrl: string
  readonly supportUrl: string
  readonly manifestShortName: 'Harnessy'
  readonly iconPath: '/harnessy.png'
  readonly markPath: '/harnessy-mark.png'
}

export interface CustomHarnessDesktopState {
  readonly data: string
  readonly home: string
  readonly agents: string
  readonly logs: string
  readonly cache: string
  readonly userData: string
}

export const CUSTOM_HARNESS_PRODUCT: CustomHarnessProduct
export const CUSTOM_HARNESS_CLIENT_BUILD_ENVIRONMENT: Readonly<Record<`DSH_CLIENT_${string}`, string>>
export function resolvePackagedCustomHarnessDesktopState(localApplicationData: string): CustomHarnessDesktopState
export function resolveDevelopmentCustomHarnessDesktopState(
  defaultData: string,
  environment?: NodeJS.ProcessEnv,
): CustomHarnessDesktopState
