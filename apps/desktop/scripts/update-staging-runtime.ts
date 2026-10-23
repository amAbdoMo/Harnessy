/** Prepare an unsigned staging runtime; the PowerShell launcher owns launch/update exclusion. */

import { cpSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { Arch, Platform, build, type Configuration } from 'electron-builder'
import { desktopTargetBuildPaths } from './desktop-build-paths.mjs'
import { updateStagingRuntime } from './staging-runtime-store.ts'
import { smokeStagingShell } from './staging-shell-smoke.ts'
import { readDesktopRuntime, verifyDesktopRuntime } from '../src/runtime-tree.ts'
import { smokePreparedRuntime } from './smoke-prepared-runtime.ts'
import { desktopElectronBuilderEnvironment, packageTarget, parseDesktopPackageInvocation } from './package-target.ts'
import { loadDesktopPackageEnvironment, validateDesktopPackageEnvironment } from './desktop-package-environment.mjs'
import { createPackagingRun } from './packaging-run.mjs'
import { CUSTOM_HARNESS_PRODUCT } from '../../../scripts/custom-harness-product.mjs'

const APP_ROOT = resolve(import.meta.dirname, '..')
const STORE = join(APP_ROOT, '.desktop-build', 'staging-runtime')

async function prepareRuntime(): Promise<void> {
  if (!process.env.npm_execpath) throw new Error('staging update: invoke through pnpm run update:staging')
  const invocation = { ...parseDesktopPackageInvocation(['win-x64', '--unsigned', '--dir']), prepareOnly: true }
  const environment = loadDesktopPackageEnvironment('win32')
  validateDesktopPackageEnvironment(environment, invocation.target, invocation)
  const secrets = Object.entries(environment).filter(([name]) => /KEY|SECRET|TOKEN|PASSWORD/iu.test(name)).map(([, value]) => value ?? '')
  const run = createPackagingRun(join(STORE, 'logs'), { purpose: 'staging-runtime' }, { secrets })
  let success = false
  try {
    await packageTarget(invocation, desktopElectronBuilderEnvironment(environment, 'local-unsigned'), run)
    success = true
  } finally { run.finish(success) }
}

async function verifyPreparedRuntime(): Promise<void> {
  const manifest: { version: string } = JSON.parse(readFileSync(join(APP_ROOT, 'package.json'), 'utf8'))
  await verifyDesktopRuntime(desktopTargetBuildPaths('win-x64').dsh, manifest.version, { platform: 'win32', arch: 'x64' })
}

async function assembleShell(directory: string): Promise<void> {
  const paths = desktopTargetBuildPaths('win-x64')
  // Collect production dependencies with the maintained packer, without installer or release hooks.
  const configuration: Configuration = {
    extends: null, appId: CUSTOM_HARNESS_PRODUCT.windowsAppId, productName: CUSTOM_HARNESS_PRODUCT.displayName,
    asar: false, npmRebuild: false, electronDist: paths.electron,
    directories: { output: join(directory, 'shell') },
    files: ['lib/main.js', 'lib/preload-*.cjs', 'lib/welcome/**/*', 'renderer/**/*', 'package.json'],
    win: { signAndEditExecutable: false },
  }
  const configFile = join(directory, 'shell-builder.json')
  writeFileSync(configFile, `${JSON.stringify(configuration, null, 2)}\n`, { flag: 'wx' })
  await build({ projectDir: APP_ROOT, targets: Platform.WINDOWS.createTarget('dir', Arch.x64), publish: 'never', config: configFile })
  rmSync(configFile)
  cpSync(join(directory, 'shell', 'win-unpacked', 'resources', 'app'), join(directory, 'app'), { recursive: true })
  cpSync(paths.dsh, join(directory, 'app', 'dsh'), { recursive: true, dereference: false })
  const shellOutput = resolve(directory, 'shell')
  if (dirname(shellOutput) !== resolve(directory)) throw new Error('staging update: shell output is outside its candidate')
  rmSync(shellOutput, { recursive: true })
}

async function main(): Promise<void> {
  if (process.platform !== 'win32') throw new Error('staging update: this launcher supports Windows only')
  const { values } = parseArgs({ options: { 'prepared-runtime': { type: 'boolean', default: false } } })
  const paths = desktopTargetBuildPaths('win-x64')
  const generation = await updateStagingRuntime(STORE, async (directory) => {
    if (values['prepared-runtime']) {
      console.log('staging update: explicitly reusing prepared artifacts; source compilation is skipped')
    } else await prepareRuntime()
    await verifyPreparedRuntime()
    await assembleShell(directory)
    cpSync(paths.electron, join(directory, 'electron'), { recursive: true, dereference: false })
    cpSync(paths.runtime, join(directory, 'runtime'), { recursive: true, dereference: false })
    cpSync(join(APP_ROOT, 'resources'), join(directory, 'app', 'resources'), { recursive: true })
    cpSync(join(APP_ROOT, 'assets'), join(directory, 'app', 'assets'), { recursive: true })
    cpSync(join(APP_ROOT, 'scripts', 'node-bin'), join(directory, 'app', 'scripts', 'node-bin'), { recursive: true })
  }, async (directory) => {
    const dsh = join(directory, 'app', 'dsh')
    const descriptor = await verifyDesktopRuntime(dsh, readDesktopRuntime(dsh).release.version, { platform: 'win32', arch: 'x64' })
    await smokePreparedRuntime(dsh, join(directory, 'electron', 'electron.exe'), join(directory, 'runtime'), descriptor)
    await smokeStagingShell(directory)
  })
  console.log(`Harnessy staging update verified and selected: ${generation}`)
  console.log('Run Start-Harnessy-Staging-App.cmd to open the same app with its existing data.')
}

// An abandoned asynchronous teardown must not turn an incomplete update into exit zero.
process.exitCode = 1
await main().then(() => { process.exitCode = 0 }).catch((error: unknown) => { console.error(error) })
