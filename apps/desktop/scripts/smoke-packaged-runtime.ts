/** Validate the assembled application, including native Office conversion outside ASAR. */
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { resolveDesktopBuildTarget, resolveDesktopTargetBuildPaths } from './desktop-build-paths.mjs'
import { packagedApplicationPaths } from './packaged-application-paths.ts'
import { readDesktopRuntime, verifyDesktopRuntime } from '../src/runtime-tree.ts'
import { verifyWindowsCode } from './windows-runtime-signature.mjs'
import { smokePreparedRuntime } from './smoke-prepared-runtime.ts'
import { resolveDesktopPackageTarget } from './package-target.ts'

const paths = resolveDesktopTargetBuildPaths()
const { values } = parseArgs({
  options: {
    unsigned: { type: 'boolean', default: false },
    'release-unsigned': { type: 'boolean', default: false },
  },
  allowPositionals: false,
})
const target = resolveDesktopBuildTarget()
const windows = target === 'win-x64'
if (values.unsigned && !windows) throw new Error('desktop smoke: unsigned artifacts require Windows')
if (values['release-unsigned'] && !windows) throw new Error('desktop smoke: release-unsigned artifacts require Windows')
if (values.unsigned && values['release-unsigned']) throw new Error('desktop smoke: choose one unsigned mode')
const unsigned = values.unsigned || values['release-unsigned']
// The local mode isolates its installer beside the release output; a release-unsigned build is the release output.
const artifacts = values.unsigned ? paths.unsignedArtifacts : paths.artifacts
const { application, resources, executable } = packagedApplicationPaths(artifacts, target)
const descriptor = await verifyDesktopRuntime(paths.dsh, readDesktopRuntime(paths.dsh).release.version,
  resolveDesktopPackageTarget(target))
if (windows && !unsigned) await verifyWindowsCode(application)
await smokePreparedRuntime(join(resources, 'app.asar', 'dsh'), executable, join(resources, 'runtime'), descriptor)
