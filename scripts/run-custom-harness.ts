/** Launch Custom Harness with product-owned storage and the named profile. */

import { spawnSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { CUSTOM_HARNESS_PRODUCT } from './custom-harness-product.ts'
import { pnpmInvocation } from './pnpm-invocation.ts'

/** Absolute product-owned filesystem locations for one launch. */
export interface CustomHarnessPaths {
  data: string
  home: string
  agents: string
  logs: string
  cache: string
}

/**
 * Resolve isolated product directories without consulting `DSH_HOME`.
 * @param environment - Launch environment carrying optional product overrides.
 * @returns product data, Harness home, log, and cache locations.
 */
export function resolveCustomHarnessPaths(environment: NodeJS.ProcessEnv = process.env): CustomHarnessPaths {
  const localAppData = environment.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local')
  const data = resolve(environment.CUSTOM_HARNESS_DATA_DIR
    ?? join(localAppData, CUSTOM_HARNESS_PRODUCT.dataDirectoryName))
  const home = resolve(environment.CUSTOM_HARNESS_HOME
    ?? join(data, CUSTOM_HARNESS_PRODUCT.harnessHomeDirectoryName))
  return {
    data,
    home,
    agents: resolve(environment.CUSTOM_HARNESS_AGENTS_DIR
      ?? join(data, CUSTOM_HARNESS_PRODUCT.agentsHomeDirectoryName)),
    logs: resolve(environment.CUSTOM_HARNESS_LOG_DIR
      ?? join(data, CUSTOM_HARNESS_PRODUCT.logDirectoryName)),
    cache: resolve(environment.CUSTOM_HARNESS_CACHE_DIR
      ?? join(data, CUSTOM_HARNESS_PRODUCT.cacheDirectoryName)),
  }
}

/**
 * Start the named product profile with isolated storage.
 * @param args - Arguments forwarded to the Web-profile command.
 * @param environment - Parent launch environment.
 * @returns the child process exit status.
 */
export function runCustomHarness(
  args: readonly string[] = process.argv.slice(2),
  environment: NodeJS.ProcessEnv = process.env,
): number {
  const paths = resolveCustomHarnessPaths(environment)
  for (const path of [paths.data, paths.home, paths.agents, paths.logs, paths.cache]) {
    mkdirSync(path, { recursive: true })
  }

  const invocation = pnpmInvocation([
    'dsh', '--profile', CUSTOM_HARNESS_PRODUCT.slug, ...args,
  ], environment)
  const result = spawnSync(invocation.command, invocation.args, {
    cwd: resolve(fileURLToPath(new URL('..', import.meta.url))),
    env: {
      ...environment,
      DSH_HOME: paths.home,
      DSH_AGENTS_HOME: paths.agents,
      CUSTOM_HARNESS_PRODUCT_NAME: CUSTOM_HARNESS_PRODUCT.displayName,
      CUSTOM_HARNESS_DATA_DIR: paths.data,
      CUSTOM_HARNESS_AGENTS_DIR: paths.agents,
      CUSTOM_HARNESS_LOG_DIR: paths.logs,
      CUSTOM_HARNESS_CACHE_DIR: paths.cache,
    },
    stdio: 'inherit',
  })
  if (result.error !== undefined) throw result.error
  return result.status ?? 1
}

const invokedPath = process.argv[1]
if (invokedPath !== undefined && import.meta.url === pathToFileURL(resolve(invokedPath)).href) {
  process.exitCode = runCustomHarness()
}
