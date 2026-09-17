/**
 * Route identity normalization for provider-aware matching.
 *
 * A configured endpoint and a public provider entry are the same gateway
 * written two ways, so the comparison happens on a normalized host: case
 * folded, a missing scheme assumed https, the scheme's default port removed,
 * the `www.` prefix dropped, and the path ignored, which is what makes a
 * trailing slash and a `/v1` suffix immaterial.
 *
 * @module @deepseek-ai/dsh-model-capabilities/routes
 */

/** A configured route's normalized identity, as provider-aware matching sees it. */
export interface NormalizedRouteHost {
  /** Lowercase host without a default port, or without any port the entry also states. */
  readonly host: string
  /** Port the endpoint states and that distinguishes gateways, when it states one. */
  readonly port?: string
}

/** A scheme prefix, so a host written without one can be parsed as an absolute URL. */
const SCHEME = /^[a-z][a-z0-9+.-]*:\/\//iu

/** Ports that carry no identity: the scheme's own default. */
const DEFAULT_PORTS: Readonly<Record<string, string>> = { 'http:': '80', 'https:': '443' }

/**
 * Normalize one configured endpoint or provider API URL to its host.
 *
 * An entry whose endpoint cannot be parsed as a URL yields undefined, which
 * means "no host to compare" rather than a host that might match by accident.
 * @param raw - configured `baseURL`, or a provider entry's API URL.
 * @returns the normalized host, or undefined when there is nothing to normalize.
 */
export function normalizeRouteHost(raw: string | undefined): NormalizedRouteHost | undefined {
  if (raw === undefined || raw.length === 0) return undefined
  let url: URL
  try {
    url = new URL(SCHEME.test(raw) ? raw : `https://${raw}`)
  } catch (_unparseableEndpoint) {
    // Only a scheme this platform rejects reaches here; a host without one was
    // given https above, so the route has no comparable identity either way.
    return undefined
  }
  const host = url.hostname.toLowerCase().replace(/^www\./u, '')
  if (host.length === 0) return undefined
  const port = url.port === '' || url.port === DEFAULT_PORTS[url.protocol] ? undefined : url.port
  return port === undefined ? { host } : { host, port }
}

/**
 * Normalize a provider identifier to its comparable form.
 *
 * Provider ids and route ids spell the same identity differently
 * (`openai-codex`, `OpenAI Codex`), so comparison keeps alphanumerics only.
 * @param raw - a route key or a provider id.
 * @returns the comparable form.
 */
export function normalizeProviderId(raw: string): string {
  return raw.toLowerCase().replace(/[^a-z0-9]/gu, '')
}

/**
 * The comparison key one normalized endpoint contributes to matching.
 *
 * The port travels with the host when the endpoint states one, because two
 * servers on one host and different ports are two endpoints: a route on
 * `127.0.0.1:9090` is not the gateway a provider entry publishes on
 * `127.0.0.1:8080`.
 * @param normalized - one endpoint's normalized identity.
 * @returns the key two endpoints are the same endpoint by.
 */
export function routeHostKey(normalized: NormalizedRouteHost): string {
  return normalized.port === undefined ? normalized.host : `${normalized.host}:${normalized.port}`
}

/**
 * The OpenRouter provider id a route names by its own identity, if any.
 *
 * OpenRouter's catalog is authoritative only for OpenRouter itself, and the
 * route's endpoint or route id is what says so — never the model id.
 * @param request - the route being interrogated.
 * @returns the matched provider id, or undefined when this is not OpenRouter.
 */
export function openRouterRouteProvider(request: {
  provider?: string
  baseURL?: string
}): string | undefined {
  const host = normalizeRouteHost(request.baseURL)?.host
  if (host === 'openrouter.ai' || host?.endsWith('.openrouter.ai') === true) return 'openrouter'
  const named = normalizeProviderId(request.provider ?? '')
  return named.length > 0 && named.includes('openrouter') ? 'openrouter' : undefined
}
