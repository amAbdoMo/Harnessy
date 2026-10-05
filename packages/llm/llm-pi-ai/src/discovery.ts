/**
 * Fresh, authenticated candidate model listings for configuration drafts.
 * Network replies determine membership; exact installed ids supply missing
 * metadata only. Unsupported builtin protocols explicitly remain catalog-only.
 * Failures never fall back to the installed list. Discovery changes no runtime
 * models or configuration: candidates require explicit adoption and saving.
 * @module dsh-llm-pi-ai/discovery
 */

import { getSupportedThinkingLevels } from '@earendil-works/pi-ai'
import type { Api, Model } from '@earendil-works/pi-ai'
import { INVALID_CREDENTIAL_CODE, LlmError, normalizeApiKey } from '@deepseek-ai/dsh-llm'
import type { LlmDiscoveredModel, LlmModelDiscoveryOperation } from '@deepseek-ai/dsh-llm'
import { attributionHeaders } from '@deepseek-ai/dsh-llm'
import { catalogModels, catalogProvider } from './catalog.ts'
import type { ModelDiscoveryAuth } from './discovery-auth.ts'

/** Protocols with an implemented native or compatible model-listing endpoint. */
const LISTABLE_PROTOCOLS: ReadonlySet<string> = new Set([
  'anthropic-messages',
  'openai-completions',
  'openai-responses',
  'openai-codex-responses',
])

/** Upstream Codex release whose native catalog protocol this implementation follows. */
const CODEX_CLIENT_VERSION = '0.160.0' // https://github.com/openai/codex/releases/tag/rust-v0.160.0

/** Security bounds over one complete listing, including every pagination request. */
const MAX_LISTING_PAGES = 10
const DISCOVERY_TIMEOUT_MS = 15_000

/** Stable API version required by Anthropic's model-listing endpoint. */
const ANTHROPIC_VERSION = '2023-06-01'

/** Largest model-list page accepted by Anthropic's public endpoint. */
const ANTHROPIC_MODEL_LIMIT = 1000

/**
 * Endpoint replies larger than this are refused. The endpoint is whatever URL
 * the user typed, so the ceiling holds on the bytes actually read rather than
 * on the length the server claims — the same two-stage shape `dsh-web-fetch`
 * uses for its own caller-supplied URLs, except that a truncated model listing
 * is not parseable, so overflow rejects instead of truncating.
 */
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024

/** Capacity fields nested by enriched model-directory replies. */
interface ListingLimit {
  context?: unknown
  output?: unknown
}

/** Per-route capacities OpenRouter nests under each entry. */
interface ListingTopProvider {
  max_completion_tokens?: unknown
}

/** One entry of a supported `GET /models` reply. */
interface ListingEntry {
  id?: unknown
  /** Native Codex catalog fields. */
  slug?: unknown
  input_modalities?: unknown
  default_reasoning_level?: unknown
  supported_reasoning_levels?: unknown
  /** Common gateway extensions; absent from the official listings. */
  name?: unknown
  display_name?: unknown
  displayName?: unknown
  contextWindow?: unknown
  context_window?: unknown
  context_length?: unknown
  max_input_tokens?: unknown
  maxOutputTokens?: unknown
  max_tokens?: unknown
  max_output_tokens?: unknown
  maxTokens?: unknown
  limit?: ListingLimit | null
  top_provider?: ListingTopProvider | null
  /**
   * Reasoning-effort levels this exact model accepts, when the gateway states
   * them. Both spellings are read because every other disclosed field here is
   * accepted in both; a listing that states none imports none.
   */
  reasoningEfforts?: unknown
  reasoning_efforts?: unknown
  defaultReasoningEffort?: unknown
  default_reasoning_effort?: unknown
}

/** A positive integer field of a listing entry, or `undefined` when absent or unusable. */
function capacity(...candidates: readonly unknown[]): number | undefined {
  for (const candidate of candidates) {
    if (typeof candidate === 'number' && Number.isInteger(candidate) && candidate > 0) return candidate
  }
  return undefined
}

/** A non-empty string field of a listing entry, or `undefined`. */
function label(...candidates: readonly unknown[]): string | undefined {
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.length > 0) return candidate
  }
  return undefined
}

/**
 * The reasoning-effort levels one listing entry states, with its default when
 * it names one. This extracts only what the entry claims; whether a claim is a
 * usable level set — usable members beside unusable ones, a default inside the
 * set, `off` alone being no offer — is decided once by the discovery seam's
 * normalization, so this reader cannot disagree with any other source.
 * @param entry - one listing entry.
 * @returns the stated levels and default, each absent when the entry states none.
 */
function statedReasoning(entry: ListingEntry | null): Pick<
  LlmDiscoveredModel,
  'reasoningEfforts' | 'defaultReasoningEffort'
> {
  const raw = entry?.reasoningEfforts ?? entry?.reasoning_efforts
  if (!Array.isArray(raw)) return {}
  const efforts = raw.filter((candidate): candidate is string => typeof candidate === 'string')
  if (efforts.length === 0) return {}
  const declared = label(entry?.defaultReasoningEffort, entry?.default_reasoning_effort)
  return {
    reasoningEfforts: efforts,
    ...declared === undefined ? {} : { defaultReasoningEffort: declared },
  }
}

/**
 * Join the endpoint base with the protocol's listing path. The base is
 * treated as a prefix rather than a URL to resolve against, so a deployment
 * path such as `https://gateway.example/openai/v1` keeps its segments instead
 * of losing them to `URL` resolution. OpenAI protocols list at
 * `{baseURL}/models`. Anthropic lists at `{root}/v1/models`, where the root is
 * the base without trailing slashes and without one trailing `/v1` segment:
 * gateway documentation publishes both spellings of the same root. Only this
 * listing URL normalizes that segment; model requests receive the configured
 * `baseURL` unchanged.
 */
function listingUrl(baseURL: string, api: string): string {
  const base = baseURL.replace(/\/+$/, '')
  if (api === 'openai-codex-responses') {
    // pi-ai accepts a backend root, /codex, or /codex/responses for inference.
    const root = base.endsWith('/codex/responses') ? base.slice(0, -10)
      : base.endsWith('/codex') ? base : `${base}/codex`
    return `${root}/models?client_version=${CODEX_CLIENT_VERSION}`
  }
  if (api !== 'anthropic-messages') return `${base}/models`
  const root = base.endsWith('/v1') ? base.slice(0, -3) : base
  return `${root}/v1/models?limit=${String(ANTHROPIC_MODEL_LIMIT)}`
}

/**
 * Read a reply body, refusing one that outgrows the ceiling. A declared length
 * is checked first so an honest server is turned away without transferring
 * anything; the accumulated total is what actually enforces the bound, because
 * a server that under-declares (or streams) tells us nothing up front.
 */
async function readBounded(response: Response, url: string, remaining: number): Promise<{ text: string; bytes: number }> {
  const oversized = (): LlmError =>
    new LlmError(`${url} answered with more than ${MAX_RESPONSE_BYTES} bytes`, 'DISCOVERY_FAILED')
  const declared = Number(response.headers.get('content-length') ?? Number.NaN)
  if (Number.isFinite(declared) && declared > remaining) {
    await response.body?.cancel()
    throw oversized()
  }
  /* v8 ignore next -- fetch always exposes a body stream on a 2xx Response; the null guard is defensive. */
  if (response.body === null) return { text: '', bytes: 0 }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > remaining) throw oversized()
      chunks.push(value)
    }
  } finally {
    /* v8 ignore next 4 -- cancel() after a completed or abandoned read settles without rejecting; unobserved best-effort cleanup. */
    await reader.cancel().catch(() => {
      // Cancel after a drained read, or after this function walked away from
      // an oversized one, is cleanup; the reply is already decided either way.
    })
  }
  const body = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }
  return { text: new TextDecoder().decode(body), bytes: total }
}

/**
 * Read one supported model-listing reply. The standard `data` array takes
 * precedence when both supported formats are present. An enriched `models`
 * map uses each property key as the endpoint-facing id; its nested `id` is
 * only a fallback for an empty key because gateways may put a canonical model
 * identity there instead of the alias they accept on requests. Only
 * object-valued map entries are models; primitive properties are ignored
 * because they may be directory metadata rather than model records.
 *
 * Entries without a usable id are skipped rather than failing the whole
 * interrogation: a single malformed row should not deny the user the rest of
 * a working endpoint's catalog. Missing names fall back to the adopted id so
 * the Web form receives a complete human-readable row.
 */
function readListing(body: unknown, api: string): LlmDiscoveredModel[] {
  const listing = body as { data?: unknown; models?: unknown } | null
  const data = listing?.data
  let listed: { readonly key?: string; readonly raw: unknown }[]
  const codex = api === 'openai-codex-responses'
  if (codex) {
    if (!Array.isArray(listing?.models)) {
      throw new LlmError('Codex model listing has no "models" array', 'DISCOVERY_FAILED')
    }
    listed = (listing.models as readonly unknown[]).map(raw => ({ raw }))
  } else if (Array.isArray(data)) {
    const rows = data as readonly unknown[]
    listed = rows.map(raw => ({ raw }))
  } else {
    const models = listing?.models
    if (models === null || typeof models !== 'object' || Array.isArray(models)) {
      throw new LlmError(
        'the endpoint\'s model listing has neither a "data" array nor a "models" object; '
        + 'enter this provider\'s models by hand',
        'DISCOVERY_FAILED',
      )
    }
    listed = Object.entries(models as Record<string, unknown>)
      .filter(([, raw]) => raw !== null && typeof raw === 'object' && !Array.isArray(raw))
      .map(([key, raw]) => ({ key, raw }))
  }
  const models: LlmDiscoveredModel[] = []
  for (const { key, raw } of listed) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) continue
    const entry = raw as ListingEntry
    const id = codex ? label(entry.slug) : label(key, entry.id)
    if (id === undefined) continue
    const name = label(entry.name, entry.display_name, entry.displayName)
    const contextWindow = capacity(
      entry.contextWindow,
      entry.context_window,
      entry.context_length,
      entry.max_input_tokens,
      entry.limit?.context,
    )
    const maxTokens = capacity(
      entry.maxOutputTokens,
      entry.max_output_tokens,
      entry.maxTokens,
      entry.max_tokens,
      entry.limit?.output,
      entry.top_provider?.max_completion_tokens,
    )
    models.push({
      id,
      ...name === undefined ? {} : { name },
      ...contextWindow === undefined ? {} : { contextWindow },
      ...maxTokens === undefined ? {} : { maxTokens },
      ...codex ? nativeCodexMetadata(entry) : statedReasoning(entry),
    })
  }
  return models
}

/** Native Codex metadata is authoritative when present, including previously unknown model ids. */
function nativeCodexMetadata(entry: ListingEntry): Partial<LlmDiscoveredModel> {
  const inputModalities = Array.isArray(entry.input_modalities)
    ? entry.input_modalities.filter((value): value is 'text' | 'image' => value === 'text' || value === 'image')
    : undefined
  const levels = Array.isArray(entry.supported_reasoning_levels)
    ? entry.supported_reasoning_levels.map((raw: unknown) => {
      if (raw === null || typeof raw !== 'object') return undefined
      return label((raw as { effort?: unknown }).effort)
    }).filter((value): value is string => value !== undefined)
    : []
  const defaultLevel = label(entry.default_reasoning_level)
  return {
    ...inputModalities === undefined ? {} : { inputModalities },
    ...levels.length === 0 ? {} : {
      reasoningEfforts: levels,
      ...defaultLevel === undefined ? {} : { defaultReasoningEffort: defaultLevel },
    },
  }
}

/**
 * The reasoning levels the installed catalog records for one model, in the
 * normalized ids the harness seam uses. A model pi-ai does not mark as
 * reasoning states none: its single implicit `off` level is the absence of the
 * parameter rather than an offer, which is the same distinction the adapter's
 * own selector metadata makes. An empty list is left to the discovery seam,
 * whose one normalization already reads it as no statement.
 * @param model - one installed catalog model.
 * @returns the stated levels, or nothing when the catalog marks no reasoning.
 */
function installedReasoning(
  model: Model<Api>,
): Pick<LlmDiscoveredModel, 'reasoningEfforts'> | Record<string, never> {
  return model.reasoning ? { reasoningEfforts: [...getSupportedThinkingLevels(model)] } : {}
}

/**
 * Accept one probe key, or refuse it before the header is built. Without this
 * the `fetch` below would throw a ByteString `TypeError` that this function's
 * catch reports as `could not reach <url>` — blaming the network for a local,
 * deterministic fault.
 * @param raw - the key typed into the form or read from storage.
 * @returns the trimmed, usable key.
 */
function usableProbeKey(raw: string): string {
  const checked = normalizeApiKey(raw)
  if (checked.ok) return checked.value
  throw new LlmError(
    checked.reason === 'empty'
      ? 'this provider\'s API key is blank; enter it on the Models page, or clear it to probe unauthenticated'
      : 'this provider\'s API key contains characters no HTTP header can carry; paste the raw key only',
    INVALID_CREDENTIAL_CODE,
  )
}

/** Host-owned inputs omitted from a configuration draft, including dormant builtin routes. */
export interface StoredModelDiscoveryProfile {
  /** Deployment headers configured on the named route. */
  readonly headers: Readonly<Record<string, string>> | undefined
  /** Configured endpoint and protocol; explicit draft fields take precedence. */
  readonly baseURL?: string
  readonly api?: string
  /** Resolve a configured credential reference only when the draft carries none. */
  readonly resolveApiKey: () => Promise<string | undefined>
  /** Resolve native auth once, capturing its identity and a stale-result check. */
  readonly resolveAuth?: (signal?: AbortSignal) => Promise<ModelDiscoveryAuth>
}

/** Metadata from one exact installed id; it never supplies listing membership. */
function installedMetadata(model: Model<Api>): LlmDiscoveredModel {
  return {
    id: model.id,
    name: model.name,
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    inputModalities: [...model.input],
    ...installedReasoning(model),
  }
}

/** Codex inference derives the account header from the access-token claim, not a second credential lookup. */
function codexAccountId(token: string): string {
  try {
    const payload: unknown = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8'))
    const claims = (payload as Record<string, unknown>)['https://api.openai.com/auth']
    const id = (claims as { chatgpt_account_id?: unknown } | undefined)?.chatgpt_account_id
    if (typeof id === 'string' && id.length > 0) return id
  } catch (error: unknown) {
    throw new LlmError('Codex model discovery requires a valid ChatGPT access token', INVALID_CREDENTIAL_CODE, { cause: error })
  }
  throw new LlmError('Codex access token has no ChatGPT account id', INVALID_CREDENTIAL_CODE)
}

/** Fetch one page under the complete listing's remaining byte budget. */
async function fetchPage(url: string, headers: Headers, signal: AbortSignal, remaining: number): Promise<{ body: unknown; bytes: number }> {
  let response: Response
  try {
    response = await fetch(url, { method: 'GET', headers, signal })
  } catch (error: unknown) {
    throw new LlmError(`could not reach ${url}`, 'DISCOVERY_FAILED', { cause: error })
  }
  if (!response.ok) {
    await response.body?.cancel()
    throw new LlmError(
      `${url} answered ${response.status}${response.status === 401 || response.status === 403 ? '; check the API key or sign-in' : ''}`,
      'DISCOVERY_FAILED',
    )
  }
  const { text, bytes } = await readBounded(response, url, remaining)
  try {
    return { body: JSON.parse(text), bytes }
  } catch (error: unknown) {
    throw new LlmError(`${url} did not answer with JSON`, 'DISCOVERY_FAILED', { cause: error })
  }
}

/**
 * Fetch fresh candidate models without changing configured or runtime models.
 * @param request - draft endpoint, protocol, optional one-shot key and cancellation.
 * @param storedProfile - host-owned defaults and auth, also available before a builtin route is configured.
 * @returns endpoint membership enriched only from exact installed ids; unsupported builtins return catalog-only candidates.
 * @throws LlmError for failed auth/fetch, stale credentials, malformed replies, or incomplete pagination.
 */
export async function discoverModels(
  request: LlmModelDiscoveryOperation,
  storedProfile?: () => StoredModelDiscoveryProfile | undefined,
): Promise<readonly LlmDiscoveredModel[]> {
  const signal = AbortSignal.any([
    ...request.signal === undefined ? [] : [request.signal],
    AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
  ])
  try {
    signal.throwIfAborted()
    const installed = request.provider === undefined ? new Map<string, Model<Api>>() : catalogModels(request.provider)
    const builtin = request.provider === undefined ? undefined : catalogProvider(request.provider)
    const stored = storedProfile?.()
    const api = request.api ?? stored?.api ?? installed.values().next().value?.api ?? 'openai-completions'
    if (!LISTABLE_PROTOCOLS.has(api)) {
      if (installed.size > 0 && request.baseURL === undefined && request.api === undefined) {
        return [...installed.values()].map(installedMetadata)
      }
      throw new LlmError(`pi-ai protocol "${api}" has no model listing this build can read; enter this provider's models by hand`, 'DISCOVERY_UNSUPPORTED')
    }
    const configuredBase = request.baseURL ?? stored?.baseURL ?? builtin?.baseUrl
    if (configuredBase === undefined || configuredBase.length === 0) {
      throw new LlmError(
        `pi-ai ships no catalog for provider "${request.provider ?? ''}", so its models can only come from its`
        + " endpoint; set a baseURL, or enter this provider's models by hand",
        'DISCOVERY_FAILED',
      )
    }
    let auth: ModelDiscoveryAuth | undefined
    let supplied = request.apiKey
    if (supplied === undefined) {
      supplied = await stored?.resolveApiKey()
      if (supplied === undefined) auth = await stored?.resolveAuth?.(signal)
    }
    const apiKey = supplied === undefined ? auth?.apiKey : usableProbeKey(supplied)
    const baseURL = request.baseURL ?? stored?.baseURL ?? auth?.baseUrl ?? configuredBase
    const headers = new Headers(stored?.headers === undefined ? undefined : Object.entries(stored.headers))
    for (const [name, value] of Object.entries(auth?.headers ?? {})) {
      if (value === null) headers.delete(name)
      else headers.set(name, value)
    }
    headers.set('accept', 'application/json')
    if (api === 'anthropic-messages') {
      headers.set('anthropic-version', ANTHROPIC_VERSION)
      if (apiKey !== undefined) headers.set('x-api-key', apiKey)
    } else if (apiKey !== undefined) {
      headers.set('authorization', `Bearer ${apiKey}`)
    }
    if (api === 'openai-codex-responses') {
      if (apiKey === undefined) throw new LlmError('sign in to ChatGPT before fetching Codex models', 'MISSING_CREDENTIAL')
      headers.set('chatgpt-account-id', codexAccountId(apiKey))
      headers.set('originator', 'pi')
    }
    for (const [name, value] of Object.entries(attributionHeaders())) headers.set(name, value)
    const initialUrl = listingUrl(baseURL, api)
    let url = initialUrl
    let bytes = 0
    const models: LlmDiscoveredModel[] = []
    const cursors = new Set<string>()
    await auth?.assertCurrent()
    for (let page = 0; page < MAX_LISTING_PAGES; page++) {
      const result = await fetchPage(url, headers, signal, MAX_RESPONSE_BYTES - bytes)
      bytes += result.bytes
      models.push(...readListing(result.body, api))
      const pagination = result.body as { has_more?: unknown; last_id?: unknown } | null
      if (api !== 'anthropic-messages' || pagination?.has_more !== true) {
        signal.throwIfAborted()
        await auth?.assertCurrent()
        if (request.apiKey === undefined && supplied !== undefined && await stored?.resolveApiKey() !== supplied) {
          throw new LlmError('model discovery credentials changed; fetch models again', 'DISCOVERY_STALE')
        }
        return models.map((model) => {
          const metadata = installed.get(model.id)
          return metadata === undefined ? { ...model, name: model.name ?? model.id } : { ...installedMetadata(metadata), ...model }
        })
      }
      const cursor = label(pagination.last_id)
      if (cursor === undefined || cursors.has(cursor) || page + 1 === MAX_LISTING_PAGES) {
        throw new LlmError('Anthropic model listing is incomplete: pagination truncated or cursor did not advance', 'DISCOVERY_TRUNCATED')
      }
      cursors.add(cursor)
      const next = new URL(initialUrl)
      next.searchParams.set('after_id', cursor)
      url = next.href
    }
    throw new LlmError('model listing is incomplete', 'DISCOVERY_TRUNCATED')
  } catch (error: unknown) {
    if (request.signal?.aborted) throw new LlmError('model discovery aborted by caller', 'ABORTED', { cause: error })
    if (signal.aborted) throw new LlmError('model discovery timed out', 'DISCOVERY_FAILED', { cause: error })
    throw error
  }
}
