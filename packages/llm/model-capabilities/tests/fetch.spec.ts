import { describe, expect, it } from 'vitest'
import {
  catalogFromResponse,
  fetchPublicCatalog,
  MAX_CATALOG_RESPONSE_BYTES,
  PUBLIC_CATALOG_ENDPOINTS,
} from '@deepseek-ai/dsh-model-capabilities'
import type { PublicCatalogSource } from '@deepseek-ai/dsh-model-capabilities'

/** One published models.dev document with a single reasoning model. */
const MODELS_DEV = {
  acme: { id: 'acme', api: 'https://api.acme.example/v1', models: { think: { reasoning_options: [{ type: 'effort', values: ['low', 'high'] }] } } },
}

/** One published OpenRouter document with a single reasoning model. */
const OPENROUTER = { data: [{ id: 'acme/think', reasoning: { supported_efforts: ['low', 'high'], default_effort: 'high' } }] }

/** One recorded request: its URL and the options the fetcher sent. */
interface Recorded {
  readonly url: string
  readonly init: RequestInit | undefined
}

/** The URL one `fetch` call names, whatever form the caller used. */
function requestedUrl(input: string | URL | Request): string {
  return typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
}

/**
 * A transport that answers a fixed response and records what it was asked.
 * @param response - the response to answer, or a thrower to fail the request.
 * @returns the transport and the requests it saw.
 */
function transport(response: Response | (() => never)): { fetch: typeof globalThis.fetch; requests: Recorded[] } {
  const requests: Recorded[] = []
  const fetchImpl = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    requests.push({ url: requestedUrl(input), init })
    if (typeof response === 'function') return Promise.reject(new Error('offline'))
    return Promise.resolve(response.clone())
  }
  return { fetch: fetchImpl, requests }
}

/** A JSON response carrying one body. */
function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' }, ...init })
}

describe('public endpoints', () => {
  it('reads the real machine-readable catalog of each database', () => {
    expect(PUBLIC_CATALOG_ENDPOINTS).toEqual({
      'models.dev': 'https://models.dev/api.json',
      openrouter: 'https://openrouter.ai/api/v1/models',
    })
  })
})

describe('fetchPublicCatalog', () => {
  it('reduces a models.dev response to the fields the resolver reads', async () => {
    const { fetch: fetchImpl, requests } = transport(json(MODELS_DEV))
    await expect(fetchPublicCatalog('models.dev', new AbortController().signal, { fetch: fetchImpl }))
      .resolves.toEqual({
        source: 'models.dev',
        catalog: { acme: { id: 'acme', api: 'https://api.acme.example/v1', models: { think: { id: 'think', reasoning_options: [{ type: 'effort', values: ['low', 'high'] }] } } } },
      })
    expect(requests[0]?.url).toBe(PUBLIC_CATALOG_ENDPOINTS['models.dev'])
  })

  it('reduces an OpenRouter response to the fields the resolver reads', async () => {
    const { fetch: fetchImpl } = transport(json(OPENROUTER))
    await expect(fetchPublicCatalog('openrouter', new AbortController().signal, { fetch: fetchImpl }))
      .resolves.toEqual({
        source: 'openrouter',
        catalog: { data: [{ id: 'acme/think', reasoning: { supported_efforts: ['low', 'high'], default_effort: 'high' } }] },
      })
  })

  it('sends one anonymous GET that carries no credential and no configured value', async () => {
    const { fetch: fetchImpl, requests } = transport(json(MODELS_DEV))
    await fetchPublicCatalog('models.dev', new AbortController().signal, { fetch: fetchImpl })
    expect(requests).toHaveLength(1)
    expect(requests[0]?.init?.method).toBe('GET')
    expect(requests[0]?.init?.body).toBeUndefined()
    expect(requests[0]?.init?.headers).toEqual({ accept: 'application/json' })
    // Nothing else rides along: no Authorization, no identity, no settings.
    expect(Object.keys(requests[0]?.init ?? {})).toEqual(['method', 'headers', 'signal'])
  })

  it('honours a caller override of the endpoint', async () => {
    const { fetch: fetchImpl, requests } = transport(json(MODELS_DEV))
    await fetchPublicCatalog('models.dev', new AbortController().signal, {
      fetch: fetchImpl,
      endpoints: { 'models.dev': 'https://mirror.example/api.json' },
    })
    expect(requests[0]?.url).toBe('https://mirror.example/api.json')
    // The database that was not overridden keeps its real endpoint.
    const other = transport(json(OPENROUTER))
    await fetchPublicCatalog('openrouter', new AbortController().signal, {
      fetch: other.fetch,
      endpoints: { 'models.dev': 'https://mirror.example/api.json' },
    })
    expect(other.requests[0]?.url).toBe(PUBLIC_CATALOG_ENDPOINTS.openrouter)
  })

  it('forwards the caller signal, so an abort reaches the transport', async () => {
    const { fetch: fetchImpl, requests } = transport(json(MODELS_DEV))
    const controller = new AbortController()
    await fetchPublicCatalog('models.dev', controller.signal, { fetch: fetchImpl })
    expect(requests[0]?.init?.signal).toBe(controller.signal)
  })

  it('refuses a non-2xx status rather than reading its body', async () => {
    const { fetch: fetchImpl } = transport(new Response('upstream is down', { status: 503 }))
    await expect(fetchPublicCatalog('models.dev', new AbortController().signal, { fetch: fetchImpl }))
      .resolves.toEqual({ source: 'models.dev', catalog: undefined })
  })

  it('refuses a body that is not JSON', async () => {
    const { fetch: fetchImpl } = transport(new Response('<html>proxy error</html>', { status: 200 }))
    await expect(fetchPublicCatalog('models.dev', new AbortController().signal, { fetch: fetchImpl }))
      .resolves.toEqual({ source: 'models.dev', catalog: undefined })
  })

  it('refuses a JSON body that reduces to no catalog', async () => {
    const { fetch: fetchImpl } = transport(json({ unrelated: true }))
    await expect(fetchPublicCatalog('models.dev', new AbortController().signal, { fetch: fetchImpl }))
      .resolves.toEqual({ source: 'models.dev', catalog: undefined })
    const empty = transport(json({ data: [] }))
    await expect(fetchPublicCatalog('openrouter', new AbortController().signal, { fetch: empty.fetch }))
      .resolves.toEqual({ source: 'openrouter', catalog: undefined })
  })

  it('refuses a body larger than the cap, by its declared length', async () => {
    const { fetch: fetchImpl } = transport(json(MODELS_DEV, {
      headers: { 'content-length': String(MAX_CATALOG_RESPONSE_BYTES + 1) },
    }))
    await expect(fetchPublicCatalog('models.dev', new AbortController().signal, { fetch: fetchImpl }))
      .resolves.toEqual({ source: 'models.dev', catalog: undefined })
  })

  it('refuses a body larger than the cap when no length was declared', async () => {
    // One byte over the cap, uncounted by the server, so the byte check itself
    // has to stop it.
    const oversized = `"${'x'.repeat(MAX_CATALOG_RESPONSE_BYTES)}"`
    const { fetch: fetchImpl } = transport(new Response(oversized, { status: 200 }))
    await expect(fetchPublicCatalog('models.dev', new AbortController().signal, { fetch: fetchImpl }))
      .resolves.toEqual({ source: 'models.dev', catalog: undefined })
  })

  it('propagates a transport failure, so cancellation stays observable', async () => {
    const { fetch: fetchImpl } = transport(() => { throw new Error('offline') })
    await expect(fetchPublicCatalog('models.dev', new AbortController().signal, { fetch: fetchImpl }))
      .rejects.toThrow('offline')
  })

  it.each(['models.dev', 'openrouter'] as const)('uses the platform fetch for %s when no transport is injected', async (source) => {
    const original = globalThis.fetch
    const seen: string[] = []
    globalThis.fetch = (input: string | URL | Request) => {
      seen.push(requestedUrl(input))
      return Promise.resolve(json(source === 'models.dev' ? MODELS_DEV : OPENROUTER))
    }
    try {
      await expect(fetchPublicCatalog(source, new AbortController().signal)).resolves.toMatchObject({ source })
      expect(seen).toEqual([PUBLIC_CATALOG_ENDPOINTS[source]])
    } finally {
      globalThis.fetch = original
    }
  })
})

describe('catalogFromResponse', () => {
  it('answers undefined for anything that is not this database’s document', () => {
    for (const source of ['models.dev', 'openrouter'] as const) {
      expect(catalogFromResponse(source, undefined)).toBeUndefined()
      expect(catalogFromResponse(source, null)).toBeUndefined()
      expect(catalogFromResponse(source, 'scalar')).toBeUndefined()
      expect(catalogFromResponse(source, [])).toBeUndefined()
    }
    expect(catalogFromResponse('models.dev', { providers: {} })).toBeUndefined()
    expect(catalogFromResponse('openrouter', { data: {} })).toBeUndefined()
  })

  it('keeps a published document that states at least one entry', () => {
    expect(catalogFromResponse('models.dev', MODELS_DEV)).toMatchObject({ acme: { id: 'acme' } })
    expect(catalogFromResponse('openrouter', OPENROUTER)).toMatchObject({ data: [{ id: 'acme/think' }] })
  })

  it('is the same reduction the bundled snapshot generator uses', () => {
    // The live path and the offline artifact read one published form the same
    // way, which is what keeps a fetched catalog and a bundled one comparable.
    const source: PublicCatalogSource = 'models.dev'
    expect(catalogFromResponse(source, MODELS_DEV)).toEqual({
      acme: { id: 'acme', api: 'https://api.acme.example/v1', models: { think: { id: 'think', reasoning_options: [{ type: 'effort', values: ['low', 'high'] }] } } },
    })
  })
})
