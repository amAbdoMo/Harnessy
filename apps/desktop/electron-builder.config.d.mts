/** Electron-builder fields asserted by the Desktop release tests. */
export interface DesktopElectronBuilderConfig {
  readonly appId: string
  readonly productName: string
  readonly executableName: string
  readonly artifactName: string
  readonly directories: {
    readonly output: string
  }
  readonly electronLanguages: readonly ['en-US']
  readonly files: readonly string[]
  readonly extraResources: readonly [
    { readonly from: string, readonly to: 'runtime' },
    { readonly from: string, readonly to: 'seed' },
    { readonly from: 'assets/harnessy.png', readonly to: 'harnessy.png' },
  ]
  readonly mac: {
    readonly identity: string | undefined
    readonly forceCodeSigning: boolean
    readonly notarize: boolean
  }
  readonly dmg: {
    readonly sign: boolean
    readonly writeUpdateInfo: boolean
  }
  readonly win: {
    readonly forceCodeSigning: boolean
    readonly executableName: string
    readonly signtoolOptions?: {
      readonly sign: unknown
      readonly signingHashAlgorithms: readonly ['sha256']
    }
    readonly target: readonly ['nsis']
  }
  readonly nsis: {
    readonly oneClick: false
    readonly perMachine: false
    readonly allowToChangeInstallationDirectory: false
    readonly createDesktopShortcut: 'always'
    readonly createStartMenuShortcut: true
    readonly shortcutName: string
    readonly deleteAppDataOnUninstall: false
    readonly runAfterFinish: false
    readonly differentialPackage: true
  }
  readonly artifactBuildCompleted: (artifact: { readonly file: string }) => Promise<void> | undefined
  readonly publish?: never
}

/**
 * Create electron-builder configuration from one release environment.
 * @param env - Packaging environment.
 * @param hostPlatform - Build-host platform used when no explicit target is present.
 * @param hostArch - Build-host architecture used when no explicit target is present.
 * @param windowsSigningPolicy - Whether Windows packaging requires the release signer.
 * @returns electron-builder configuration.
 */
export function createElectronBuilderConfig(
  env?: NodeJS.ProcessEnv,
  hostPlatform?: NodeJS.Platform,
  hostArch?: string,
  windowsSigningPolicy?: 'required' | 'local-unsigned',
): DesktopElectronBuilderConfig

declare const electronBuilderConfig: DesktopElectronBuilderConfig

export default electronBuilderConfig
