import { describe, expect, it } from 'vitest'
import {
  boundCommandCodeText,
  COMMAND_CODE_TRUNCATION_MARKER,
  MAX_COMMAND_CODE_OUTPUT_BYTES,
} from '../src/bound.ts'

const encoder = new TextEncoder()

describe('boundCommandCodeText', () => {
  it('leaves text inside the budget untouched', () => {
    expect(boundCommandCodeText('short', 64)).toBe('short')
  })

  it('keeps a value exactly at the budget untouched', () => {
    const exact = 'a'.repeat(64)
    expect(boundCommandCodeText(exact, 64)).toBe(exact)
  })

  it('marks a value one byte over the budget', () => {
    const result = boundCommandCodeText('a'.repeat(65), 64)
    expect(result).toContain(COMMAND_CODE_TRUNCATION_MARKER)
    expect(encoder.encode(result).byteLength).toBeLessThanOrEqual(64)
  })

  it('never splits a multi-byte character', () => {
    const text = '漢'.repeat(40)
    const result = boundCommandCodeText(text, 40)
    expect(encoder.encode(result).byteLength).toBeLessThanOrEqual(40)
    const kept = result.slice(0, result.indexOf(COMMAND_CODE_TRUNCATION_MARKER))
    expect(kept).toBe('漢'.repeat(kept.length))
    expect(kept.length).toBeGreaterThan(0)
    expect(result).toContain(COMMAND_CODE_TRUNCATION_MARKER)
  })

  it('returns only what its own marker fits when the budget is smaller than the marker', () => {
    const result = boundCommandCodeText('漢'.repeat(40), 10)
    expect(encoder.encode(result).byteLength).toBeLessThanOrEqual(10)
    expect(result).not.toContain('\uFFFD')
  })

  it('bounds an oversized single chunk to the parent-visible budget', () => {
    const result = boundCommandCodeText('x'.repeat(1024 * 1024), MAX_COMMAND_CODE_OUTPUT_BYTES)
    expect(encoder.encode(result).byteLength).toBeLessThanOrEqual(MAX_COMMAND_CODE_OUTPUT_BYTES)
    expect(result.endsWith(COMMAND_CODE_TRUNCATION_MARKER)).toBe(true)
  })

  it('stays inside a budget smaller than its own marker', () => {
    const result = boundCommandCodeText('x'.repeat(100), 10)
    expect(encoder.encode(result).byteLength).toBeLessThanOrEqual(10)
  })
})
