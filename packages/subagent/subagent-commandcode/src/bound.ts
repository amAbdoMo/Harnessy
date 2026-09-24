/**
 * The one bound on text the parent Session may see from a delegated run.
 *
 * @module @deepseek-ai/dsh-subagent-commandcode/bound
 */

/** Maximum UTF-8 bytes of one delegated run's text as the parent Session sees it. */
export const MAX_COMMAND_CODE_OUTPUT_BYTES = 12 * 1024

/** Marker appended to a value this module shortened. */
export const COMMAND_CODE_TRUNCATION_MARKER = '\n[Command Code output truncated]'

const encoder = new TextEncoder()
const decoder = new TextDecoder()

/**
 * Shorten text to a UTF-8 byte budget without splitting a character.
 * @param text - the complete value to bound.
 * @param maxBytes - the byte budget for the result, marker included.
 * @returns the original text when it fits, otherwise a head cut with the marker.
 */
export function boundCommandCodeText(text: string, maxBytes: number): string {
  const complete = encoder.encode(text)
  if (complete.byteLength <= maxBytes) return text

  const marker = encoder.encode(COMMAND_CODE_TRUNCATION_MARKER)
  if (marker.byteLength >= maxBytes) {
    return decoder.decode(marker.subarray(0, boundaryAt(marker, maxBytes)))
  }
  const budget = maxBytes - marker.byteLength
  return decoder.decode(complete.subarray(0, boundaryAt(complete, budget)))
    + COMMAND_CODE_TRUNCATION_MARKER
}

/**
 * Find the largest prefix length that ends on a UTF-8 character boundary.
 * @param bytes - encoded text.
 * @param limit - the exclusive upper bound of the prefix.
 * @returns a length at or below `limit` that never splits a character.
 */
function boundaryAt(bytes: Uint8Array, limit: number): number {
  let end = Math.min(limit, bytes.byteLength)
  // Continuation bytes are `10xxxxxx`; stepping back off them lands on the
  // first byte of the next character.
  while (end > 0 && ((bytes[end] as number) & 0b1100_0000) === 0b1000_0000) end -= 1
  return end
}
