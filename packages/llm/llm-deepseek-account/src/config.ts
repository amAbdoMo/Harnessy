/** Account-token settings with optional discovery of the official default model catalog. */
import z from '@deepseek-ai/schemastery'
import type { LaunchEnvironmentSnapshot } from '@deepseek-ai/dsh-launch-environment'
import {
  deepSeekConfigFields, isBuiltInCatalog, modelListingConfigFields, modelListingURL, plainOptions as protocolOptions,
  PUBLIC_BASE_URL, resolveAdapterOptions as resolveProtocolOptions, resolveListingTiming,
} from '@deepseek-ai/dsh-llm-deepseek'
import type {
  Config as ProtocolConfig, DeepSeekConnectionOptions, ListingSettings, ModelListingConfig, ModelListingOptions,
  Options as ProtocolOptions,
} from '@deepseek-ai/dsh-llm-deepseek'

/** Account configuration; authentication comes exclusively from the account service. */
export type Config = ProtocolConfig & ModelListingConfig
export const Config = z.object({ ...deepSeekConfigFields, ...modelListingConfigFields })

/** Plain account deployment settings, retaining customized model catalogs. */
export type Options = ProtocolOptions & ModelListingOptions

/** One account operation's protocol and optional listing settings. */
export interface ResolvedAccountOptions extends DeepSeekConnectionOptions {
  /** Present only for the official origin with this build's unmodified default models. */
  listing?: ListingSettings
}

/**
 * Read current validated account settings without selecting a credential.
 * @param config - live account plugin configuration.
 * @returns detached settings for one resolution.
 */
export function plainOptions(config: Config): Options {
  return protocolOptions(config)
}

/**
 * Resolve protocol settings and discovery while retaining explicit catalogs and custom endpoints.
 * @param options - plain account settings.
 * @param environment - application launch environment.
 * @returns settings captured from one configuration generation.
 */
export function resolveAccountOptions(options: Options, environment?: LaunchEnvironmentSnapshot): ResolvedAccountOptions {
  const { modelsTimeoutMs: _timeout, modelsMaxAgeMs: _maxAge, ...protocol } = options
  const timing = resolveListingTiming(options, 'llm-deepseek-account')
  const connection = resolveProtocolOptions(protocol, environment)
  const listed = new URL(connection.baseURL).origin === new URL(PUBLIC_BASE_URL).origin
    && isBuiltInCatalog(protocol.models ?? connection.models)
  return { ...connection, ...listed ? { listing: { url: modelListingURL(connection.baseURL), ...timing } } : {} }
}
