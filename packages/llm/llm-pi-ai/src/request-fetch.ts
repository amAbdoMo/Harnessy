/** Preserve network error codes before provider SDKs flatten fetch failures. */

const NETWORK_CODES = [
  /^(?:ECONNRESET|ECONNREFUSED|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|ENOTFOUND|EAI_AGAIN|UND_ERR_[A-Z_]+|ERR_TLS_[A-Z_]+)$/u,
  /^(?:CERT_HAS_EXPIRED|DEPTH_ZERO_SELF_SIGNED_CERT|SELF_SIGNED_CERT_IN_CHAIN|UNABLE_TO_VERIFY_LEAF_SIGNATURE)$/u,
]

function networkCodes(cause: unknown): string[] {
  if (!(cause instanceof Error)) return []
  const nested: readonly unknown[] = cause instanceof AggregateError ? cause.errors.map((entry: unknown) => entry) : []
  const candidates = [cause, ...nested]
  return candidates.flatMap((candidate) => {
    if (!(candidate instanceof Error)) return []
    const code: unknown = Reflect.get(candidate, 'code')
    return typeof code === 'string' && NETWORK_CODES.some(pattern => pattern.test(code)) ? [code] : []
  })
}

/**
 * Send one provider HTTP request, retaining only recognized network codes in a fetch failure's message.
 * @param input - provider URL or prepared request.
 * @param init - provider headers, body, and cancellation signal.
 * @returns the original HTTP response; rejects without exposing request data or nested error text.
 */
export async function requestFetch(input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> {
  try { return await fetch(input, init) }
  catch (error: unknown) {
    if (!(error instanceof TypeError) || error.message !== 'fetch failed') throw error
    const codes = [...new Set(networkCodes(error.cause))]
    if (codes.length === 0) throw error
    throw new TypeError(`fetch failed (${codes.join(', ')})`, { cause: error })
  }
}
