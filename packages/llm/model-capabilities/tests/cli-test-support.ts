/**
 * Shared scaffolding for the command's specs: publish the store the way the
 * mounted plugin does, so a spec exercises the command against the same service
 * the shipped composition provides.
 */

import type { Context } from '@deepseek-ai/cordis'
import { MODEL_CAPABILITY_STORE_SERVICE } from '@deepseek-ai/dsh-model-capabilities'
import type { PublicCatalogStore } from '@deepseek-ai/dsh-model-capabilities'

/**
 * Publish one catalog store under the service name the plugin owns.
 * @param ctx - the context to publish on.
 * @param store - the store the command should read.
 */
export function registerTestStore(ctx: Context, store: PublicCatalogStore): void {
  ctx.provide(MODEL_CAPABILITY_STORE_SERVICE, store)
}
