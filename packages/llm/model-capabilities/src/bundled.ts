/**
 * The bundled snapshot as a composition consumes it: a generated data module,
 * validated once at load, exposed as catalogs the slice-1 resolver already
 * reads.
 *
 * Nothing here reads a file. The artifact is a module like any other, so the
 * catalog is part of whatever module graph the composition already loads.
 *
 * @module @deepseek-ai/dsh-model-capabilities/bundled
 */

import { snapshotModule } from './snapshot/public-model-capabilities.ts'
import { parseSnapshot } from './snapshot.ts'
import type { ModelCapabilitySnapshot } from './snapshot.ts'
import type { PublicCatalog } from './types.ts'

/**
 * Recursively freeze one parsed document, so no consumer can edit the catalog
 * a later lookup reads.
 * @param value - the value to freeze.
 * @returns the same value, frozen through every nested object and array.
 */
function freezeSnapshot(value: unknown): unknown {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value
  for (const nested of Object.values(value)) freezeSnapshot(nested)
  return Object.freeze(value)
}

/** The bundled snapshot, validated and deep frozen once at module load. */
const SNAPSHOT = freezeSnapshot(parseSnapshot(snapshotModule)) as ModelCapabilitySnapshot

/**
 * Where the bundled metadata came from: its schema version, generation time,
 * and the capture identity of each database it was built from.
 */
export const bundledSnapshotMetadata: ModelCapabilitySnapshot = SNAPSHOT

/**
 * The bundled catalogs, most authoritative first.
 *
 * The order is the precedence this layer resolves in, so a caller composes a
 * later live or cached catalog by putting it in front of this list and passing
 * the result to the unchanged resolver.
 * @returns the OpenRouter and models.dev catalogs, marked `origin: 'bundled'`.
 */
export function loadBundledPublicCatalogs(): readonly PublicCatalog[] {
  return [
    { source: 'openrouter', origin: 'bundled', entries: SNAPSHOT.catalogs.openRouter },
    { source: 'models.dev', origin: 'bundled', entries: SNAPSHOT.catalogs.modelsDev },
  ]
}
