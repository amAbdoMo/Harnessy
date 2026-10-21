/** Product asset I/O is external; production resolver and semantic budget validation stay real. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { resolveDesktopCompanionConfig } from '../src/companion.ts'

const asset = vi.hoisted(() => ({ read: undefined as (() => string) | undefined }))
vi.mock('node:fs', async (original) => {
  const fs = await original<typeof import('node:fs')>()
  return { ...fs, readFileSync: (...args: Parameters<typeof fs.readFileSync>) => {
    const path = args[0]
    if (path instanceof URL && path.pathname.endsWith('/desktop-host/companion-deployment.json') && asset.read !== undefined) {
      return asset.read()
    }
    return fs.readFileSync(...args)
  } }
})
afterEach(() => { asset.read = undefined })

describe('required product companion deployment', () => {
  it('honors a deliberately disabled product deployment without inventing a relay', () => {
    asset.read = () => '{}'
    expect(resolveDesktopCompanionConfig({})).toEqual({})
  })

  it.each(['null', '[]', '{', '{"origin":"https://misnamed.invalid"}', '{"httpsOrigin":"https://incomplete.invalid"}'])
  ('rejects malformed product data instead of silently disabling or selecting a fallback (%s)', (raw) => {
    asset.read = () => raw
    expect(() => resolveDesktopCompanionConfig({})).toThrow()
  })

  it('refuses a missing required deployment asset rather than inventing defaults', () => {
    asset.read = () => { throw new Error('Fixture deployment asset missing') }
    expect(() => resolveDesktopCompanionConfig({})).toThrow('Fixture deployment asset missing')
  })

  it('bounds complete product UTF-8 bytes before parsing, including whitespace and multibyte content', () => {
    asset.read = () => '{}' + ' '.repeat(8190)
    expect(resolveDesktopCompanionConfig({})).toEqual({})
    asset.read = () => '{}' + ' '.repeat(8191)
    expect(() => resolveDesktopCompanionConfig({})).toThrow('byte limit')
    asset.read = () => JSON.stringify({ extra: 'é'.repeat(4096) })
    expect(() => resolveDesktopCompanionConfig({})).toThrow('byte limit')
  })
})
