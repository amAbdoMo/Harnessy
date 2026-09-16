/** Counts every managed process the composed Command Code plugin starts. */

import type { Context } from '@deepseek-ai/cordis'
import type { SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'

export const name = 'commandcode-loader-spawn-counter'
export const inject = ['subprocess']

/** Global the driver reads; the child process owns one isolated counter. */
const COUNTER = '__commandCodeSpawnCount'

declare global {
  var __commandCodeSpawnCount: number | undefined
}

/**
 * Wrap the shared process owner with a counter.
 * @param ctx - Loader context supplying the subprocess seam.
 */
export function apply(ctx: Context): void {
  globalThis[COUNTER] = 0
  const original = ctx.subprocess.spawn.bind(ctx.subprocess)
  ctx.subprocess.spawn = (spec: SubprocessSpawnSpec) => {
    globalThis[COUNTER] = (globalThis[COUNTER] ?? 0) + 1
    return original(spec)
  }
}
