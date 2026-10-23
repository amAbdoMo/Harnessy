/** Self-contained staging generations; selection changes only after candidate validation. */

import { createHash, randomUUID } from 'node:crypto'
import { lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const GENERATION = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u
const CHECKED_FILES = [
  'electron/electron.exe', 'app/package.json', 'app/lib/main.js',
  'app/lib/preload-app.cjs', 'app/dsh/desktop-runtime.json',
  'runtime/primary-runtime/runtime.json', 'runtime/primary-runtime/dependencies/pnpm/bin/pnpm.mjs', 'app/scripts/node-bin/node.cmd',
] as const

/** Selected and preceding runtime identifiers, never paths supplied by a caller. */
export interface StagingSelection {
  readonly schemaVersion: 1
  readonly current: string
  readonly previous: string | null
}

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

/**
 * Reject any link in a candidate, including directory junctions into the editable checkout.
 * @param directory - Materialized candidate root, not a user data directory.
 */
export function assertMaterializedStagingTree(directory: string): void {
  const entry = lstatSync(directory)
  if (entry.isSymbolicLink()) throw new Error(`staging runtime: linked entry ${directory}`)
  if (entry.isDirectory()) {
    for (const name of readdirSync(directory)) assertMaterializedStagingTree(join(directory, name))
  } else if (!entry.isFile()) throw new Error(`staging runtime: unsupported entry ${directory}`)
}

/**
 * Read the durable selection, rejecting malformed or traversing generation identifiers.
 * @param root - Staging-runtime store under the Desktop build directory.
 * @returns Existing selection, or undefined before the first successful update.
 */
export function readStagingSelection(root: string): StagingSelection | undefined {
  let text: string
  try { text = readFileSync(join(root, 'active.json'), 'utf8') } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
  const value: unknown = JSON.parse(text)
  if (typeof value !== 'object' || value === null || !('schemaVersion' in value) || value.schemaVersion !== 1
    || !('current' in value) || typeof value.current !== 'string' || !GENERATION.test(value.current)
    || !('previous' in value) || (value.previous !== null && (typeof value.previous !== 'string' || !GENERATION.test(value.previous)))) {
    throw new Error('staging runtime: invalid active.json; restore its verified selection before updating')
  }
  return { schemaVersion: 1, current: value.current, previous: value.previous }
}

/**
 * Seal and smoke a new generation before atomically replacing the selection.
 * The caller serializes updates and launches. Failed candidates and old generations are retained;
 * no Session downgrade or runtime fallback runs here.
 * @param root - Staging-runtime store under the Desktop build directory.
 * @param prepare - Materialize into a fresh directory; must not modify existing generations.
 * @param verify - Exercise the candidate against isolated smoke data, then terminate its processes.
 * @returns Identifier of the selected generation.
 */
export async function updateStagingRuntime(
  root: string,
  prepare: (directory: string) => Promise<void>,
  verify: (directory: string) => Promise<void>,
): Promise<string> {
  const previous = readStagingSelection(root)
  const id = randomUUID()
  const directory = join(root, 'generations', id)
  mkdirSync(directory, { recursive: true })
  await prepare(directory)
  assertMaterializedStagingTree(directory)
  const checks = CHECKED_FILES.map(path => ({ path, sha256: sha256(join(directory, path)) }))
  await verify(directory)
  assertMaterializedStagingTree(directory)
  for (const check of checks) {
    if (sha256(join(directory, check.path)) !== check.sha256) throw new Error(`staging runtime: smoke modified ${check.path}`)
  }
  writeFileSync(join(directory, 'verified.json'), `${JSON.stringify({ schemaVersion: 2, id, checks }, null, 2)}\n`, { flag: 'wx', flush: true })
  const temporary = join(root, `active.${id}.tmp`)
  writeFileSync(temporary, `${JSON.stringify({ schemaVersion: 1, current: id, previous: previous?.current ?? null }, null, 2)}\n`, { flag: 'wx', flush: true })
  renameSync(temporary, join(root, 'active.json'))
  return id
}
