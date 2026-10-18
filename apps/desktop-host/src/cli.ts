/** Public dsh commands using the immutable runtime carried by the Desktop installation. */

import { resolve } from 'node:path'
import { runCli } from '@deepseek-ai/dsh/lib/bin.js'
import { installOfficeEngineResolution } from './office-engine.ts'
import { resolveDesktopCliOptions } from './cli-options.ts'

/**
 * Run the ordinary CLI with Desktop's shared package manager and reserved-profile plugin access.
 * @param runtimeDir - Prepared or ASAR-contained production DSH package tree.
 * @returns Completion of the selected CLI command; profile plugins own their process lifetime.
 */
export async function runDesktopCli(runtimeDir: string): Promise<void> {
  const options = resolveDesktopCliOptions(runtimeDir, process.env)
  installOfficeEngineResolution(runtimeDir)
  await runCli(options)
}

if (import.meta.main) {
  if (process.platform === 'win32') {
    const { installWindowsCliSignals } = await import('./windows-cli-signals.ts')
    await installWindowsCliSignals()
  }
  const runtimeDir = resolve(import.meta.dirname, '../../../..')
  await runDesktopCli(runtimeDir)
}
