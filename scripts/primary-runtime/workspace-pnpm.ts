/** Read the workspace-owned pnpm installation used to prepare the shared payload. */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Resolve pnpm from the repository root, never from a carrier's local dependency graph.
 * @param repositoryRoot - Absolute workspace directory owning the pnpm development dependency.
 * @returns Installed package directory and the version copied into runtime metadata.
 * @throws when pnpm is unavailable or its installed manifest has no version.
 */
export function resolveWorkspacePnpm(repositoryRoot: string): { directory: string; version: string } {
  const directory = join(repositoryRoot, 'node_modules', 'pnpm')
  const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')) as { version?: unknown }
  if (typeof manifest.version !== 'string' || manifest.version.length === 0) {
    throw new Error('workspace pnpm: installed package has no version')
  }
  return { directory, version: manifest.version }
}
