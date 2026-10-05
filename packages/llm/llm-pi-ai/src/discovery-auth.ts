/** Operation-local pi-ai auth resolution and stale-credential checks for model discovery. */

import { builtinModels } from '@earendil-works/pi-ai/providers/all'
import type { AuthContext, Credential, CredentialStore, ModelAuth } from '@earendil-works/pi-ai'
import { LlmError } from '@deepseek-ai/dsh-llm'
import { deepEqualJson } from '@deepseek-ai/dsh-util-values'

/** Request auth captured once, with a check that its credential source has not changed. */
export interface ModelDiscoveryAuth extends ModelAuth {
  /** Reject a result authenticated before a logout, account switch, or key replacement. */
  readonly assertCurrent: () => Promise<void>
}

/**
 * Resolve through pi-ai's normal credential bridge, including locked OAuth refresh.
 * Store reads and refresh results capture the credential actually used; checks do
 * not resolve auth again or adopt a different account as the request identity.
 * @param provider - installed provider id.
 * @param auth - the same store and ambient context used by the runtime adapter.
 * @param signal - cancellation covering auth resolution and refresh.
 * @returns request auth and its operation-local stale-credential check.
 */
export async function resolveBuiltinDiscoveryAuth(
  provider: string,
  auth: { credentials: CredentialStore; authContext: AuthContext },
  signal?: AbortSignal,
): Promise<ModelDiscoveryAuth> {
  let used: Credential | undefined
  const env = new Map<string, string | undefined>()
  const credentials: CredentialStore = {
    list: options => auth.credentials.list(options),
    delete: (id, options) => auth.credentials.delete(id, options),
    async read(id, options) {
      const credential = await auth.credentials.read(id, options)
      used = structuredClone(credential)
      return credential
    },
    async modify(id, mutate, options) {
      const credential = await auth.credentials.modify(id, mutate, options)
      used = structuredClone(credential)
      return credential
    },
  }
  const models = builtinModels({
    credentials,
    authContext: {
      fileExists: path => auth.authContext.fileExists(path),
      async env(name) {
        const value = await auth.authContext.env(name)
        env.set(name, value)
        return value
      },
    },
  })
  const options = signal === undefined ? undefined : { signal }
  const result = await models.getAuth(provider, options)
  return {
    ...result?.auth,
    async assertCurrent() {
      const current = await auth.credentials.read(provider, options)
      const sameEnv = await Promise.all([...env].map(async ([name, value]) =>
        await auth.authContext.env(name) === value))
      if (!deepEqualJson(current, used) || sameEnv.includes(false)) {
        throw new LlmError('model discovery credentials changed; fetch models again', 'DISCOVERY_STALE')
      }
    },
  }
}
