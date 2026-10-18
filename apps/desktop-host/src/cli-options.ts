/** Resolve Desktop CLI package operations against the exact payload and physical Node launchers. */
import { delimiter, dirname, join, resolve } from 'node:path'
import type { RunCliOptions } from '@deepseek-ai/dsh/lib/bin.js'
import { runtimeArchivePath } from './office-engine.ts'

/**
 * Select the shared package manager without changing an explicitly configured payload directory.
 * @param runtimeDir - Prepared or ASAR-contained DSH package tree.
 * @param environment - Launch environment with the optional primary-runtime override and inherited PATH.
 * @returns Ordinary CLI options using shared pnpm and Node launchers from the same selected runtime.
 * @throws when the primary-runtime override is empty.
 */
export function resolveDesktopCliOptions(runtimeDir: string, environment: NodeJS.ProcessEnv): RunCliOptions {
  const configured = environment.DSH_DESKTOP_PRIMARY_RUNTIME_DIR
  if (configured === '') throw new Error('desktop CLI: DSH_DESKTOP_PRIMARY_RUNTIME_DIR must not be empty')
  const primaryRuntime = configured === undefined
    ? join(dirname(runtimeArchivePath(runtimeDir) ?? runtimeDir), 'runtime', 'primary-runtime')
    : resolve(configured)
  const supportDir = dirname(primaryRuntime)
  return {
    manageDesktopProfile: true,
    packageManager: {
      command: process.execPath,
      args: ['--expose-internals', join(primaryRuntime, 'dependencies', 'pnpm', 'bin', 'pnpm.mjs')],
      env: {
        ELECTRON_RUN_AS_NODE: '1',
        DSH_DESKTOP_NODE_EXECUTABLE: process.execPath,
        PATH: `${join(supportDir, 'bin')}${delimiter}${environment.PATH ?? ''}`,
      },
    },
  }
}
