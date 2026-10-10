/** Discover live workspace packages for the repository's tsdown build phases. */

import { globSync } from 'node:fs'
import { dirname, sep } from 'node:path'

/**
 * Select packages with manifests, excluding generated residue from removed packages.
 * @param root - Repository root containing the workspace directories.
 * @param face - Compiler phase selecting the Host-only desktop host package.
 * @returns Sorted repository-relative package directories with forward slashes.
 */
export function buildWorkspaceDirectories(root: string, face: 'host' | 'client'): string[] {
  const patterns = ['vendor/*/package.json', 'packages/*/*/package.json', 'apps/cli/package.json']
  if (face === 'host') patterns.push('apps/desktop-host/package.json')
  return globSync(patterns, { cwd: root }).map(path => dirname(path).split(sep).join('/')).sort()
}
