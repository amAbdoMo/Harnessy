import {
  resolveMacOSNotarizationEnvironment,
  resolveMacOSSigningEnvironment,
} from './scripts/desktop-release-environment.mjs'
import { CUSTOM_HARNESS_PRODUCT } from '../../scripts/custom-harness-product.mjs'
import { notarizeMacOSDiskImageArtifact } from './scripts/notarize-macos-disk-images.mjs'
import { verifyMacOSSignatureAfterSign } from './scripts/verify-macos-signature.mjs'
import {
  createWindowsTokenSigner,
  installWindowsNsisBootstrapSigner,
} from './scripts/windows-sign.mjs'
import { desktopTargetBuildPaths, resolveDesktopBuildTarget } from './scripts/desktop-build-paths.mjs'

/**
 * Create electron-builder configuration from one release environment.
 * @param {NodeJS.ProcessEnv} env - Packaging environment.
 * @param {NodeJS.Platform} hostPlatform - Build-host platform used when no explicit target is present.
 * @param {string} hostArch - Build-host architecture used when no explicit target is present.
 * @param {'required' | 'local-unsigned'} windowsSigningPolicy - Windows signing policy for this config entry point.
 * @returns {object} electron-builder configuration.
 */
export function createElectronBuilderConfig(
  env = process.env,
  hostPlatform = process.platform,
  hostArch = process.arch,
  windowsSigningPolicy = 'required',
) {
  const targetPlatform = env.DSH_DESKTOP_TARGET_PLATFORM
  const packagesMacOS = targetPlatform === 'darwin' || (targetPlatform === undefined && hostPlatform === 'darwin')
  const packagesWindows = targetPlatform === 'win32'
  const packagesLocalUnsignedWindows = packagesWindows && windowsSigningPolicy === 'local-unsigned'
  if (windowsSigningPolicy === 'local-unsigned' && !packagesWindows) {
    throw new Error('local unsigned packaging supports only the Windows target')
  }
  const macOSSigning = packagesMacOS ? resolveMacOSSigningEnvironment(env) : undefined
  if (packagesMacOS) resolveMacOSNotarizationEnvironment(env)
  const windowsSigner = packagesWindows && !packagesLocalUnsignedWindows
    ? createWindowsTokenSigner({
        certificateFile: env.DSH_DESKTOP_WINDOWS_CER_FILE,
        signTool: env.DSH_DESKTOP_WINDOWS_SIGNTOOL,
        tokenPin: env.DSH_DESKTOP_WINDOWS_TOKEN_PIN,
        keyContainer: env.DSH_DESKTOP_WINDOWS_KEY_CONTAINER,
      })
    : undefined
  if (windowsSigner !== undefined) {
    installWindowsNsisBootstrapSigner({ sign: windowsSigner })
  }
  const buildPaths = desktopTargetBuildPaths(resolveDesktopBuildTarget(env, hostPlatform, hostArch))
  return {
    appId: CUSTOM_HARNESS_PRODUCT.windowsAppId,
    productName: CUSTOM_HARNESS_PRODUCT.displayName,
    executableName: CUSTOM_HARNESS_PRODUCT.executableName,
    artifactName: `${CUSTOM_HARNESS_PRODUCT.installerName}-\${version}-\${os}-\${arch}.\${ext}`,
    directories: { output: buildPaths.artifacts },
    asar: true,
    electronLanguages: ['en-US'],
    files: [
      'lib/*.js',
      'lib/*.cjs',
      'renderer/**/*',
      'src/startup.html',
      'src/startup.css',
      'assets/harnessy.png',
      'package.json',
    ],
    extraResources: [
      { from: buildPaths.runtime, to: 'runtime' },
      { from: buildPaths.seed, to: 'seed' },
      { from: 'assets/harnessy.png', to: 'harnessy.png' },
    ],
    mac: {
      category: 'public.app-category.developer-tools',
      identity: macOSSigning?.signingIdentity,
      forceCodeSigning: true,
      hardenedRuntime: true,
      notarize: true,
      target: ['dmg', 'zip'],
    },
    dmg: {
      sign: true,
      writeUpdateInfo: false,
    },
    afterSign: context => {
      if (context.electronPlatformName !== 'darwin') return
      verifyMacOSSignatureAfterSign(context, macOSSigning ?? resolveMacOSSigningEnvironment(env))
    },
    artifactBuildCompleted: artifact => {
      if (!artifact.file.endsWith('.dmg')) return
      return notarizeMacOSDiskImageArtifact(
        artifact,
        env,
        macOSSigning ?? resolveMacOSSigningEnvironment(env),
      )
    },
    win: {
      forceCodeSigning: !packagesLocalUnsignedWindows,
      icon: 'assets/harnessy.png',
      executableName: CUSTOM_HARNESS_PRODUCT.executableName,
      ...(packagesLocalUnsignedWindows ? {} : {
        signtoolOptions: {
          sign: windowsSigner,
          signingHashAlgorithms: ['sha256'],
        },
      }),
      target: ['nsis'],
    },
    linux: {
      category: 'Development',
      icon: 'assets/harnessy.png',
      target: ['AppImage'],
    },
    nsis: {
      oneClick: false,
      perMachine: false,
      // A selectable directory makes electron-builder treat every manually
      // launched installer as a potentially relocated install. It then
      // removes and recreates shortcuts, which breaks Windows taskbar pins.
      // Keep the registered location and shortcut identity stable instead.
      allowToChangeInstallationDirectory: false,
      createDesktopShortcut: 'always',
      createStartMenuShortcut: true,
      shortcutName: CUSTOM_HARNESS_PRODUCT.displayName,
      deleteAppDataOnUninstall: false,
      runAfterFinish: false,
      differentialPackage: true,
    },
  }
}
