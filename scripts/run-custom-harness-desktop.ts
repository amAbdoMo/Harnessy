/** Launch the Custom Harness Windows desktop host from verified customized artifacts. */

import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { readClientBuildRecord, type ClientBuildRecord } from './client-build-environment.ts'
import { CUSTOM_HARNESS_CLIENT_BUILD_ENVIRONMENT, CUSTOM_HARNESS_PRODUCT } from './custom-harness-product.ts'
import { resolveCustomHarnessPaths, type CustomHarnessPaths } from './run-custom-harness.ts'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const desktopRoot = resolve(root, 'apps/desktop')

export function desktopEnvironment(
  paths: CustomHarnessPaths,
  electronExecutable: string,
  nodeExecutable: string,
  environment: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return {
    ...environment,
    DSH_HOME: paths.home,
    DSH_AGENTS_HOME: paths.agents,
    CUSTOM_HARNESS_DATA_DIR: paths.data,
    CUSTOM_HARNESS_AGENTS_DIR: paths.agents,
    CUSTOM_HARNESS_LOG_DIR: paths.logs,
    CUSTOM_HARNESS_CACHE_DIR: paths.cache,
    CUSTOM_HARNESS_PRODUCT_NAME: CUSTOM_HARNESS_PRODUCT.displayName,
    CUSTOM_HARNESS_DESKTOP_APP_ID: CUSTOM_HARNESS_PRODUCT.windowsAppId,
    CUSTOM_HARNESS_DESKTOP_PROFILE: CUSTOM_HARNESS_PRODUCT.slug,
    CUSTOM_HARNESS_DESKTOP_NODE_EXECUTABLE: nodeExecutable,
    CUSTOM_HARNESS_DESKTOP_DSH_ENTRY: resolve(root, 'apps/cli/lib/bin.js'),
    CUSTOM_HARNESS_DESKTOP_JOB_LAUNCHER: resolve(desktopRoot, 'assets/windows-job-launcher.exe'),
    CUSTOM_HARNESS_DESKTOP_WORKING_DIRECTORY: root,
    CUSTOM_HARNESS_DESKTOP_USER_DATA: resolve(paths.cache, 'DesktopUserData'),
    CUSTOM_HARNESS_DESKTOP_LOG_DIR: paths.logs,
    CUSTOM_HARNESS_DESKTOP_ICON: resolve(desktopRoot, 'assets/custom-harness.png'),
    CUSTOM_HARNESS_ELECTRON_EXECUTABLE: electronExecutable,
  }
}

function electronExecutable(environment: NodeJS.ProcessEnv): string {
  const explicit = environment.CUSTOM_HARNESS_ELECTRON_EXECUTABLE
  if (explicit !== undefined) {
    const executable = resolve(explicit)
    if (!existsSync(executable)) throw new Error(`Electron executable does not exist: ${executable}`)
    return executable
  }
  const installed = resolve(root, 'node_modules/electron/dist/electron.exe')
  if (existsSync(installed)) return installed
  throw new Error(
    'No pinned Electron runtime is installed. Install the Phase 9 desktop dependencies or set '
    + 'CUSTOM_HARNESS_ELECTRON_EXECUTABLE to an audited development runtime.',
  )
}

function windowsJobLauncher(): string {
  const output = resolve(desktopRoot, 'assets/windows-job-launcher.exe')
  const source = resolve(desktopRoot, 'native/windows-job-launcher.cs')
  if (!existsSync(output) || statSync(output).mtimeMs < statSync(source).mtimeMs) {
    execFileSync('powershell.exe', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
      resolve(desktopRoot, 'scripts/build-windows-job-launcher.ps1'),
    ], { cwd: root, stdio: 'inherit' })
  }
  return output
}

function prepareProductDirectories(paths: CustomHarnessPaths): void {
  for (const productDirectory of [paths.data, paths.home, paths.agents, paths.logs, paths.cache, resolve(paths.cache, 'DesktopUserData')]) {
    mkdirSync(productDirectory, { recursive: true })
  }
}

export function assertCustomHarnessBuildRecord(buildRecord: ClientBuildRecord): void {
  for (const [name, requiredValue] of Object.entries(CUSTOM_HARNESS_CLIENT_BUILD_ENVIRONMENT)) {
    if (buildRecord.environment[name] !== requiredValue) {
      throw new Error(`The client build record does not describe Custom Harness (${name}).`)
    }
  }
}

function verifyDesktopArtifacts(): void {
  assertCustomHarnessBuildRecord(readClientBuildRecord(root))
  if (!existsSync(resolve(root, 'apps/cli/lib/bin.js'))) {
    throw new Error('The built CLI is missing; run npm run build:custom-harness first.')
  }
}

export function runCustomHarnessDesktop(environment: NodeJS.ProcessEnv = process.env): number {
  if (process.platform !== 'win32') throw new Error('The Phase 8 Custom Harness desktop host supports Windows only.')
  verifyDesktopArtifacts()
  const paths = resolveCustomHarnessPaths(environment)
  prepareProductDirectories(paths)
  windowsJobLauncher()
  const runtime = electronExecutable(environment)
  const launch = spawnSync(runtime, [desktopRoot], {
    cwd: root,
    env: desktopEnvironment(paths, runtime, process.execPath, environment),
    stdio: 'inherit',
    windowsHide: true,
  })
  if (launch.error !== undefined) throw launch.error
  return launch.status ?? 1
}

const invokedPath = process.argv[1]
if (invokedPath !== undefined && import.meta.url === pathToFileURL(resolve(invokedPath)).href) {
  process.exitCode = runCustomHarnessDesktop()
}
