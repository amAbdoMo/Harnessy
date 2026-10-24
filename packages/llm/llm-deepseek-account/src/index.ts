/** Account-token authentication and discovery for the DeepSeek account route. */
import type {} from '@deepseek-ai/cordis-plugin-loader'
import type { Context } from '@deepseek-ai/cordis'
import { ACCOUNT_QUOTA_EXCEEDED_CODE, APP_IDENTITY, LlmError, QUOTA_EXCEEDED_CODE } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-deepseek-account'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import {
  catalogModelInfo, ModelListingCache, refuseListedModel, registerDeepSeekProvider, requestModelListing, resolveListedCatalog,
} from '@deepseek-ai/dsh-llm-deepseek'
import type {
  CatalogRefusal, DeepSeekCatalogModel, DeepSeekRequestAuth, ListingView, ModelListing,
} from '@deepseek-ai/dsh-llm-deepseek'
import type { ResolvedAccountOptions } from './config.ts'

import { Config, plainOptions, resolveAccountOptions } from './config.ts'
export { Config } from './config.ts'
export const name = 'llm-deepseek-account'
export const inject = ['llm']

const PROVIDER = 'deepseek-account'
const LOG_TAG = '[llm-deepseek-account]'

/** Catalog and request settings captured for one account operation. */
interface AccountConnection extends ResolvedAccountOptions {
  readonly offered: readonly DeepSeekCatalogModel[]
  readonly refusals: ReadonlyMap<string, CatalogRefusal>
}

export function apply(ctx: Context, config: Config): void {
  const options = () => resolveAccountOptions(plainOptions(config), launchEnvironmentOf(ctx))
  options()
  const resolveAuth = async (connection: ResolvedAccountOptions): Promise<DeepSeekRequestAuth> => {
    const account = ctx.get('deepseekAccount')
    const token = await account?.resolveToken(connection.baseURL)
    if (token === undefined) throw new LlmError('Sign in to DeepSeek to use the account provider. The request destination must allow account authentication.', 'ACCOUNT_SIGN_IN_REQUIRED')
    return {
      headers: { 'x-dsh-auth-token': token },
      onRequestError: async (error) => {
        if (!(error instanceof LlmError)) return error
        if (error.code === QUOTA_EXCEEDED_CODE) {
          return new LlmError(error.message, ACCOUNT_QUOTA_EXCEEDED_CODE, { ...error.failure, cause: error })
        }
        if (error.failure.status !== 401) return error
        const rejected = new LlmError(error.message, 'ACCOUNT_TOKEN_INVALID', { ...error.failure, cause: error })
        try { await account?.rejectToken(token) }
        catch (_credentialRemovalFailed) { /* Storage failure cannot replace the inference failure. */ }
        return rejected
      },
    }
  }
  const presentToken = async (connection: ResolvedAccountOptions): Promise<string | undefined> => {
    try { return (await resolveAuth(connection)).headers['x-dsh-auth-token'] }
    catch (error) {
      if (error instanceof LlmError && error.code === 'ACCOUNT_SIGN_IN_REQUIRED') return undefined
      throw error
    }
  }
  const listings = new ModelListingCache({
    credential: async url => ctx.get('deepseekAccount')?.resolveToken(url),
    load: (url, token, signal) => requestModelListing(url, { 'x-dsh-auth-token': token }, signal),
    now: () => Date.now(),
    info: (message) => { console.error(LOG_TAG, message) },
    warn: (message) => { console.warn(LOG_TAG, message) },
  })
  let reportedListing: ModelListing | undefined
  const connectionOf = (connection: ResolvedAccountOptions, view: ListingView | undefined): AccountConnection => {
    if (view === undefined) return { ...connection, offered: connection.models, refusals: new Map() }
    const catalog = resolveListedCatalog({
      listing: view.listing?.entries, supported: connection.models,
      routeMaxTokens: connection.maxTokens, clientVersion: APP_IDENTITY.version,
    })
    if (view.listing !== reportedListing) {
      reportedListing = view.listing
      for (const problem of catalog.problems) console.warn(LOG_TAG, problem)
    }
    return { ...connection, models: catalog.resolution, offered: catalog.offered, refusals: catalog.refusals }
  }
  ctx.llm.registerConfigurableProviders([
    { provider: PROVIDER, displayName: 'DeepSeek Account', settingsNs: ctx.fiber.entry?.options.id ?? name, settingsPath: [] },
  ])
  registerDeepSeekProvider<AccountConnection>(ctx, PROVIDER, {
    options: () => {
      const connection = options()
      return connectionOf(connection, connection.listing === undefined ? undefined : listings.current())
    },
    connect: async (signal) => {
      const connection = options()
      if (connection.listing === undefined) return connectionOf(connection, undefined)
      try { return connectionOf(connection, await listings.view(connection.listing, signal)) }
      catch (error) {
        if (signal?.aborted === true) throw error
        // Authentication reports lookup failures during the logged model request.
        return connectionOf(connection, undefined)
      }
    },
    resolveAuth, providerName: 'DeepSeek Account',
    admit: (connection, model) => { refuseListedModel(model, connection.refusals.get(model)) },
    discoverModels: async (provider) => {
      const connection = options()
      if (connection.listing === undefined) {
        if (await presentToken(connection) === undefined) return []
        return connection.models.map(model => catalogModelInfo(provider, model))
      }
      const view = await listings.view(connection.listing)
      return view.authenticated ? connectionOf(connection, view).offered.map(model => catalogModelInfo(provider, model)) : []
    },
  })
  let following = options().listing !== undefined
  ctx.on('loader/volatile-update', () => {
    let next: boolean
    try { next = options().listing !== undefined }
    catch (_rejectedConfiguration) { return }
    if (next !== following) listings.invalidate()
    following = next
  })
  ctx.effect(() => () => listings.dispose(), 'llm-deepseek-account: model listing')
}
