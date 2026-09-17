/**
 * The public catalog fetcher: one keyless GET per database, validated before
 * anything downstream sees it.
 *
 * `fetch` is the platform's, so this package adds no networking dependency. A
 * response is read as bytes under a size cap, parsed, and reduced by the same
 * curation the bundled snapshot uses; anything else — a non-2xx status, an
 * oversized body, bytes that are not JSON, a document that reduces to nothing —
 * answers `undefined` so the caller keeps whatever catalog it already had. The
 * request carries no credential, no identity, and no configured value: an
 * ordinary anonymous `GET` that asks for JSON.
 *
 * @module @deepseek-ai/dsh-model-capabilities/fetch
 */

import { catalogFromResponse } from './store.ts'
import type { PublicCatalogFetch } from './store.ts'
import type { PublicCatalogSource } from './types.ts'

/** The public endpoints this layer reads, keyed by database. */
export const PUBLIC_CATALOG_ENDPOINTS: Readonly<Record<PublicCatalogSource, string>> = {
  'models.dev': 'https://models.dev/api.json',
  openrouter: 'https://openrouter.ai/api/v1/models',
}

/**
 * Largest response body this layer will read, in bytes.
 *
 * The captured catalogs are a few megabytes; the cap is an order of magnitude
 * above them, so it never truncates a real catalog while still refusing an
 * endpoint that answers with something unbounded. The check counts bytes, not
 * characters, so a body of multibyte text cannot slip past it.
 */
export const MAX_CATALOG_RESPONSE_BYTES = 32 * 1024 * 1024

/** The one request header this layer sends: it wants JSON back. */
const CATALOG_REQUEST_HEADERS: Readonly<Record<string, string>> = { accept: 'application/json' }

/** What one fetcher needs to know; everything else is fixed by the public contract. */
export interface PublicCatalogFetcherOptions {
  /**
   * HTTP transport; defaults to the platform `fetch`.
   *
   * Injectable so a test drives every response shape without a socket, and so a
   * deployment with its own transport — a proxy, a custom dispatcher — can
   * supply one without this package learning about proxying.
   */
  readonly fetch?: typeof globalThis.fetch
  /** Endpoint per database; defaults to {@link PUBLIC_CATALOG_ENDPOINTS}. */
  readonly endpoints?: Readonly<Partial<Record<PublicCatalogSource, string>>>
}

/**
 * Read a response body, refusing one larger than the cap.
 *
 * The declared length is checked first when the server states one; the
 * accumulated bytes are checked otherwise, so a body that keeps growing is
 * abandoned rather than buffered.
 * @param response - the response to read.
 * @returns the decoded body, or undefined when it is missing or over the cap.
 */
async function readCappedBody(response: Response): Promise<string | undefined> {
  const declared = Number(response.headers.get('content-length') ?? Number.NaN)
  if (Number.isFinite(declared) && declared > MAX_CATALOG_RESPONSE_BYTES) return undefined
  const body = new Uint8Array(await response.arrayBuffer())
  if (body.byteLength > MAX_CATALOG_RESPONSE_BYTES) return undefined
  return new TextDecoder().decode(body)
}

/**
 * Fetch one database's catalog.
 *
 * A remote condition never throws: a non-2xx status, an oversized body, and
 * bytes that are not JSON each answer `undefined`, which the store reads as
 * "keep what you have". Cancellation through `signal` propagates as the
 * transport's own rejection, so a caller's abort stays observable.
 * @param source - the database to fetch.
 * @param signal - caller cancellation; aborts the request.
 * @param options - transport and endpoint overrides.
 * @returns the reduced catalog, or undefined when this response stated nothing usable.
 */
export async function fetchPublicCatalog(
  source: PublicCatalogSource,
  signal: AbortSignal,
  options: PublicCatalogFetcherOptions = {},
): Promise<PublicCatalogFetch> {
  const request = options.fetch ?? globalThis.fetch
  const endpoint = options.endpoints?.[source] ?? PUBLIC_CATALOG_ENDPOINTS[source]
  const response = await request(endpoint, { method: 'GET', headers: CATALOG_REQUEST_HEADERS, signal })
  if (!response.ok) return { source, catalog: undefined }
  const text = await readCappedBody(response)
  if (text === undefined) return { source, catalog: undefined }
  let document: unknown
  try {
    document = JSON.parse(text) as unknown
  } catch (_notJson) {
    // A proxy error page or a truncated body parses as nothing; the caller
    // keeps its previous catalog rather than replacing it with an empty one.
    return { source, catalog: undefined }
  }
  return { source, catalog: catalogFromResponse(source, document) }
}
