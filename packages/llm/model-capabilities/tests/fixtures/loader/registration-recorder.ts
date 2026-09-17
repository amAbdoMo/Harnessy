/** Record the order in which capability sources register on the LLM seam. */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-llm'

/** Stable Cordis plugin name. */
export const name = 'model-capabilities-registration-recorder'

/** The seam must exist before this row can wrap its registration. */
export const inject = ['llm']

/** Every capability source name registered through the seam, in order. */
const registered: string[] = []

/** The one wrapped runtime, so a repeated mount cannot wrap it twice. */
const wrapped = new WeakSet<object>()

/**
 * Install the recorder and mount the subjects under test.
 *
 * Patching the seam's own registration, rather than observing an effect, is what
 * makes the mount order observable: the seam asks capability sources in
 * registration order and the first answer wins, so this order *is* the
 * precedence between a local integration and public metadata.
 * @param ctx - the Loader root context.
 */
export function apply(ctx: Context): void {
  const runtime = ctx.llm
  if (!wrapped.has(runtime)) {
    wrapped.add(runtime)
    const register = runtime.registerModelCapabilitySource.bind(runtime)
    runtime.registerModelCapabilitySource = (source, lookup) => {
      registered.push(source)
      return register(source, lookup)
    }
  }
  globalThis.__modelCapabilityRegistrations = registered
}

declare global {
  /** The registration recorder's shared list, read by the driver after boot. */
  var __modelCapabilityRegistrations: string[] | undefined
}
