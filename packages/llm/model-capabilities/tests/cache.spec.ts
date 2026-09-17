import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createPublicCatalogCache,
  CACHE_SCHEMA_VERSION,
  PUBLIC_CATALOG_CACHE_PATH,
} from '@deepseek-ai/dsh-model-capabilities'
import type { CachedCatalog } from '@deepseek-ai/dsh-model-capabilities'

/** Scratch directories this spec created, removed after each test. */
const scratch: string[] = []

/**
 * One scratch directory for a cache file.
 * @returns the directory path.
 */
function scratchDir(): string {
  const directory = mkdtempSync(join(tmpdir(), 'model-capabilities-cache-'))
  scratch.push(directory)
  return directory
}

afterEach(() => {
  while (scratch.length > 0) rmSync(scratch.pop() as string, { recursive: true, force: true })
})

/** One entry as a successful refresh would commit it. */
function entry(source: 'models.dev' | 'openrouter', catalog: unknown = { acme: { id: 'acme' } }): CachedCatalog {
  return { source, fetchedAt: '2026-09-16T12:00:00.000Z', catalog }
}

describe('the cache location', () => {
  it('lives under the Harness home, so each installation owns its own', () => {
    expect(PUBLIC_CATALOG_CACHE_PATH().replaceAll('\\', '/')).toMatch(/model-capabilities\/public-catalogs\.json$/u)
  })
})

describe('createPublicCatalogCache', () => {
  it('answers nothing when the file is absent, which is the first run', async () => {
    const path = join(scratchDir(), 'nested', 'public-catalogs.json')
    await expect(createPublicCatalogCache(path).read()).resolves.toEqual([])
  })

  it('round-trips one committed refresh', async () => {
    const path = join(scratchDir(), 'public-catalogs.json')
    const cache = createPublicCatalogCache(path)
    await cache.write([entry('models.dev'), entry('openrouter')])
    await expect(cache.read()).resolves.toEqual([entry('models.dev'), entry('openrouter')])
  })

  it('creates the directory it needs', async () => {
    const directory = scratchDir()
    const path = join(directory, 'deeper', 'still', 'public-catalogs.json')
    await createPublicCatalogCache(path).write([entry('models.dev')])
    expect(readdirSync(join(directory, 'deeper', 'still'))).toEqual(['public-catalogs.json'])
  })

  it('replaces the file in one step, leaving no temp file behind', async () => {
    const directory = scratchDir()
    const path = join(directory, 'public-catalogs.json')
    const cache = createPublicCatalogCache(path)
    await cache.write([entry('models.dev')])
    await cache.write([entry('openrouter')])
    expect(readdirSync(directory)).toEqual(['public-catalogs.json'])
    expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({ schemaVersion: CACHE_SCHEMA_VERSION })
  })

  it('keeps the previous file when a replacement cannot be committed', async () => {
    const directory = scratchDir()
    const path = join(directory, 'public-catalogs.json')
    const cache = createPublicCatalogCache(path)
    await cache.write([entry('models.dev')])
    const before = readFileSync(path, 'utf8')
    // A directory where the temp sibling wants to be is the cheapest way to
    // make the exclusive create fail without changing the target's contents.
    await expect(createPublicCatalogCache(join(directory, 'public-catalogs.json', 'impossible.json')).write([entry('openrouter')]))
      .rejects.toThrow()
    expect(readFileSync(path, 'utf8')).toBe(before)
  })

  it('reports a write failure to its caller rather than swallowing it', async () => {
    const directory = scratchDir()
    // A path whose parent is a regular file cannot be created.
    const file = join(directory, 'blocker')
    writeFileSync(file, 'not a directory\n')
    await expect(createPublicCatalogCache(join(file, 'public-catalogs.json')).write([entry('models.dev')]))
      .rejects.toThrow()
  })

  it('reads a malformed file as no cache', async () => {
    const path = join(scratchDir(), 'public-catalogs.json')
    writeFileSync(path, 'not json at all\n')
    await expect(createPublicCatalogCache(path).read()).resolves.toEqual([])
  })

  it('reads a document of the wrong shape as no cache', async () => {
    const path = join(scratchDir(), 'public-catalogs.json')
    for (const document of [null, 'scalar', [], { schemaVersion: 99, entries: [] }, { schemaVersion: 1 }]) {
      writeFileSync(path, `${JSON.stringify(document)}\n`)
      await expect(createPublicCatalogCache(path).read()).resolves.toEqual([])
    }
  })

  it('drops only the entries this build cannot use', async () => {
    const path = join(scratchDir(), 'public-catalogs.json')
    writeFileSync(path, `${JSON.stringify({
      schemaVersion: CACHE_SCHEMA_VERSION,
      entries: [
        { source: 'models.dev', fetchedAt: '2026-09-16T12:00:00.000Z', schemaVersion: CACHE_SCHEMA_VERSION, catalog: { acme: {} } },
        { source: 'unknown-database', fetchedAt: '2026-09-16T12:00:00.000Z', schemaVersion: CACHE_SCHEMA_VERSION, catalog: {} },
        { source: 'openrouter', fetchedAt: '2026-09-16T12:00:00.000Z', schemaVersion: CACHE_SCHEMA_VERSION + 1, catalog: {} },
        { source: 'openrouter', schemaVersion: CACHE_SCHEMA_VERSION, catalog: {} },
        'scalar',
        null,
        [],
      ],
    })}\n`)
    await expect(createPublicCatalogCache(path).read()).resolves.toEqual([entry('models.dev', { acme: {} })])
  })

  it('states its schema version on the document and on every entry', async () => {
    const path = join(scratchDir(), 'public-catalogs.json')
    await createPublicCatalogCache(path).write([entry('models.dev')])
    const document = JSON.parse(readFileSync(path, 'utf8')) as { schemaVersion: number; entries: { schemaVersion: number }[] }
    expect(document.schemaVersion).toBe(CACHE_SCHEMA_VERSION)
    expect(document.entries[0]?.schemaVersion).toBe(CACHE_SCHEMA_VERSION)
  })

  it('ends the file with one trailing newline', async () => {
    const path = join(scratchDir(), 'public-catalogs.json')
    await createPublicCatalogCache(path).write([entry('models.dev')])
    const text = readFileSync(path, 'utf8')
    expect(text.endsWith('}\n')).toBe(true)
    expect(text.endsWith('\n\n')).toBe(false)
  })
})
