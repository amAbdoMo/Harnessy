/**
 * The durable public catalog cache: one JSON file under the Harness home,
 * replaced atomically so a crash never leaves a half-written catalog.
 *
 * The file holds the last successfully fetched catalog per database, each with
 * the time its fetch completed and that entry's own schema version. It is
 * advisory: a file that is absent, unreadable, malformed, or written by another
 * schema version reads as empty, and the bundled snapshot answers instead. A
 * write failure is reported to the caller, which keeps serving the catalogs it
 * already has in memory.
 *
 * @module @deepseek-ai/dsh-model-capabilities/cache
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import type { CachedCatalog, PublicCatalogCache } from './store.ts'

/** Schema version of the cache file. A different one reads as no cache. */
export const CACHE_SCHEMA_VERSION = 1

/** Directories between the Harness home and the cache file. */
const CACHE_SEGMENTS: readonly string[] = ['model-capabilities', 'public-catalogs.json']

/** Permission bits for the cache file: a deployment's own metadata. */
const CACHE_FILE_MODE = 0o600

/** Permission bits for the directories this package creates. */
const CACHE_DIR_MODE = 0o700

/** One entry as the file stores it. */
interface StoredCatalogEntry {
  /** Database this entry belongs to. */
  readonly source: string
  /** When the fetch that produced it completed, in ISO 8601 UTC. */
  readonly fetchedAt: string
  /** Schema version this entry was written under. */
  readonly schemaVersion: number
  /** The reduced catalog. */
  readonly catalog: unknown
}

/** The cache document. */
interface StoredCache {
  /** File-format version. */
  readonly schemaVersion: number
  /** One entry per database a fetch has succeeded for. */
  readonly entries: readonly StoredCatalogEntry[]
}

/**
 * Read one stored entry back into the shape the store consumes.
 *
 * Only structure is judged here: the entry must state a known database, a
 * parseable fetch time, and this build's schema version. Age is not judged,
 * because an expired catalog stays the best available answer.
 * @param value - one parsed entry.
 * @returns the entry, or undefined when it is not one this build can use.
 */
function storedEntry(value: unknown): CachedCatalog | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const entry = value as Partial<StoredCatalogEntry>
  if (entry.schemaVersion !== CACHE_SCHEMA_VERSION) return undefined
  if (entry.source !== 'models.dev' && entry.source !== 'openrouter') return undefined
  if (typeof entry.fetchedAt !== 'string') return undefined
  return { source: entry.source, fetchedAt: entry.fetchedAt, catalog: entry.catalog }
}

/**
 * The path of the cache file this build reads and writes.
 * @returns the absolute path under the resolved Harness home.
 */
export const PUBLIC_CATALOG_CACHE_PATH = (): string => join(resolveDshHome(), ...CACHE_SEGMENTS)

/**
 * Read one cache document, keeping only the entries this build can use.
 * @param path - cache file to read.
 * @returns the usable entries; empty when the file is absent or unreadable.
 */
function readCacheDocument(path: string): readonly CachedCatalog[] {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (_absentOrUnreadableCache) {
    // Absent on first run, and unreadable when permissions or a lock
    // interfere. Either way the bundled snapshot is the floor, so this is an
    // empty cache rather than a failure.
    return []
  }
  let document: unknown
  try {
    document = JSON.parse(text) as unknown
  } catch (_notJson) {
    return []
  }
  if (typeof document !== 'object' || document === null || Array.isArray(document)) return []
  const stored = document as Partial<StoredCache>
  if (stored.schemaVersion !== CACHE_SCHEMA_VERSION || !Array.isArray(stored.entries)) return []
  return stored.entries.flatMap((entry) => {
    const usable = storedEntry(entry)
    return usable === undefined ? [] : [usable]
  })
}

/**
 * Replace one cache document atomically.
 * @param path - cache file to write.
 * @param entries - every entry the file should hold.
 * @returns when the replacement is committed.
 */
async function writeCacheDocument(path: string, entries: readonly CachedCatalog[]): Promise<void> {
  const document: StoredCache = {
    schemaVersion: CACHE_SCHEMA_VERSION,
    entries: entries.map(entry => ({
      source: entry.source,
      fetchedAt: entry.fetchedAt,
      schemaVersion: CACHE_SCHEMA_VERSION,
      catalog: entry.catalog,
    })),
  }
  await writeFileAtomic(path, `${JSON.stringify(document, null, 2)}\n`, {
    mode: CACHE_FILE_MODE,
    dirMode: CACHE_DIR_MODE,
  })
}

/**
 * Create the file-backed cache.
 *
 * The path is resolved from the Harness home, so each installation and profile
 * owns its own cache the way every other piece of runtime state does. Nothing is
 * read until {@link PublicCatalogCache.read} is called, and nothing is written
 * until a refresh commits a success, so mounting the layer touches no file.
 * @param path - cache file to use; defaults to {@link PUBLIC_CATALOG_CACHE_PATH}.
 * @returns the cache handle.
 */
export function createPublicCatalogCache(path: string = PUBLIC_CATALOG_CACHE_PATH()): PublicCatalogCache {
  return {
    read: () => Promise.resolve(readCacheDocument(path)),
    write: entries => writeCacheDocument(path, entries),
  }
}
