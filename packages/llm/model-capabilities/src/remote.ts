/**
 * The Models page's read of what capability applies to each configured model.
 *
 * This is a projection of `inspect.ts`, not a second resolver: the same
 * configured-route join, the same store selection, and the same resolution the
 * runtime seam and the `--models-sync` / `--models-explain` commands use. It
 * exists so a browser surface can render provenance without importing a Host
 * package or re-deriving a match.
 *
 * @module @deepseek-ai/dsh-model-capabilities/remote
 */

import type { Context } from '@deepseek-ai/cordis'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { capabilityInspectionViews, readConfiguredRoutes } from './inspect.ts'
import type { ModelCapabilityInspectionView } from './inspect.ts'
import { MODEL_CAPABILITIES_NAMESPACE, resolvePolicy } from './config.ts'
import type { ModelCapabilitiesConfig } from './config.ts'
import { MODEL_CAPABILITY_STORE_SERVICE } from './store-service.ts'

/** Settings namespace the configured routes live in. */
const LLM_PI_AI_NAMESPACE = 'llm-pi-ai'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The Models page's capability-provenance read. */
    modelCapabilitiesInspector: ModelCapabilitiesInspector
  }
}

/** The Remote namespace a surface reads capability provenance through. */
export class ModelCapabilitiesInspector extends TypertRemoteService {
  /** The store whose selection every answer is resolved against. */
  static inject = [MODEL_CAPABILITY_STORE_SERVICE]

  /**
   * @param ctx - Host context carrying the mounted catalog store.
   */
  constructor(ctx: Context) {
    super(ctx, 'modelCapabilitiesInspector', { namespace: 'modelCapabilities' })
  }

  /**
   * Report what capability applies to every configured model, and where it came
   * from.
   * @param signal - carrier cancellation supplied by the Remote transport.
   * @returns one projection per configured model, in configuration order.
   */
  // The Remote contract is asynchronous, so the method is too, even though this
  // read settles without waiting on anything.
  @Remote('inspect')
  // eslint-disable-next-line @typescript-eslint/require-await -- the Remote contract is async
  async remoteExportInspect(signal: AbortSignal): Promise<ModelCapabilityInspectionView[]> {
    signal.throwIfAborted()
    const store = this.ctx.get(MODEL_CAPABILITY_STORE_SERVICE)
    /* v8 ignore next -- the class injects this service, so the fiber never activates without it. */
    if (store === undefined) return []
    // The store is read without loading it: a surface reports what the runtime
    // is answering with right now, and a cache read belongs to the layer that
    // owns startup, not to a page render.
    const settings = this.ctx.get('settings')
    const config = settings?.get(MODEL_CAPABILITIES_NAMESPACE) as ModelCapabilitiesConfig | undefined
    const enabled = config === undefined ? true : resolvePolicy(config).enabled
    const routes = readConfiguredRoutes(settings?.get(LLM_PI_AI_NAMESPACE))
    return [...capabilityInspectionViews(routes, store, enabled)]
  }
}
