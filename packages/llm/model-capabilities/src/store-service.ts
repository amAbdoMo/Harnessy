/**
 * The Cordis service key the mounted catalog store is published under.
 *
 * It lives in its own module because two plugins need it and neither may import
 * the other: the composition row publishes the store, and the Models page's
 * Remote service requires it. Importing across those two would make the modules
 * circular, and the class that reads this key would evaluate before the key
 * exists.
 *
 * @module @deepseek-ai/dsh-model-capabilities/store-service
 */

import type { PublicCatalogStore } from './store.ts'

/**
 * Service name carrying the mounted catalog store.
 *
 * A diagnostics surface — the `--models-sync` / `--models-explain` commands and
 * the Models page's provenance read — reads the same store the capability
 * source answers from, so it reports the runtime's own selections rather than
 * rebuilding them.
 */
export const MODEL_CAPABILITY_STORE_SERVICE = 'modelCapabilities'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The mounted public catalog store, for diagnostics commands and surfaces. */
    modelCapabilities?: PublicCatalogStore
  }
}
