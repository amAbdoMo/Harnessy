/** One-time migration for core packages installed by released legacy Desktop profiles. */

import { lstatSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { dump, load } from 'js-yaml'
import { DESKTOP_PACKAGE_SET_FILE, readDesktopCorePackageSet } from './core-package-set.ts'

/** Marker written after the legacy core-package migration completes. */
export const LEGACY_PROFILE_CORE_MIGRATION_FILE = 'desktop-core-packages-migrated-v1.json'

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('desktop legacy profile migration: expected an object')
  }
  return value as Record<string, unknown>
}

function stat(path: string): ReturnType<typeof lstatSync> | undefined {
  try {
    return lstatSync(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    return undefined
  }
}

function remove(path: string): boolean {
  const entry = stat(path)
  if (entry === undefined) return false
  if (entry.isSymbolicLink()) unlinkSync(path)
  else rmSync(path, { recursive: entry.isDirectory() })
  return true
}

function requireDirectory(path: string): void {
  const entry = stat(path)
  if (entry !== undefined && (!entry.isDirectory() || entry.isSymbolicLink())) {
    throw new Error(`desktop legacy profile migration: package parent is not a real directory: ${path}`)
  }
}

function requireRegularFile(path: string): boolean {
  const entry = stat(path)
  if (entry === undefined) return false
  if (!entry.isFile() || entry.isSymbolicLink()) {
    throw new Error(`desktop legacy profile migration: metadata is not a regular file: ${path}`)
  }
  return true
}

function prune(value: Record<string, unknown>, field: string, names: ReadonlySet<string>): boolean {
  if (value[field] === undefined) return false
  const entries = object(value[field])
  let changed = false
  for (const name of names) {
    if (!Object.hasOwn(entries, name)) continue
    Reflect.deleteProperty(entries, name)
    changed = true
  }
  return changed
}

/**
 * Remove core packages recorded by a legacy released Desktop, then mark the profile migrated.
 * The caller holds the profile lock and has not started the Host. Unrelated packages, bundle
 * selections, settings, credentials, sessions, and user patches remain unchanged.
 * @param profile - Absolute Desktop profile directory.
 */
export function migrateLegacyProfileCorePackages(profile: string): void {
  const markerPath = join(profile, LEGACY_PROFILE_CORE_MIGRATION_FILE)
  const recordPath = join(profile, DESKTOP_PACKAGE_SET_FILE)
  if (requireRegularFile(markerPath)) {
    const value: unknown = JSON.parse(readFileSync(markerPath, 'utf8'))
    if (object(value).schemaVersion !== 1) throw new Error('desktop legacy profile migration: invalid completion marker')
    return
  }
  if (!requireRegularFile(recordPath)) return

  const names = new Set(readDesktopCorePackageSet(profile).packages.map(entry => entry.name))
  const roots = [join(profile, 'node_modules'), join(profile, '.dsh-module-fallback', 'node_modules')]
  requireDirectory(join(profile, '.dsh-module-fallback'))
  for (const root of roots) {
    requireDirectory(root)
    for (const name of names) requireDirectory(dirname(join(root, name)))
  }

  const manifestPath = join(profile, 'package.json')
  let manifest: Record<string, unknown> | undefined
  if (requireRegularFile(manifestPath)) {
    const value: unknown = JSON.parse(readFileSync(manifestPath, 'utf8'))
    manifest = object(value)
  }
  const workspacePath = join(profile, 'pnpm-workspace.yaml')
  const workspace = requireRegularFile(workspacePath)
    ? object(load(readFileSync(workspacePath, 'utf8')))
    : undefined
  let manifestChanged = false
  if (manifest !== undefined) {
    for (const field of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
      manifestChanged = prune(manifest, field, names) || manifestChanged
    }
    if (manifest.pnpm !== undefined) manifestChanged = prune(object(manifest.pnpm), 'overrides', names) || manifestChanged
  }
  const workspaceChanged = workspace !== undefined && prune(workspace, 'overrides', names)
  const packageResidue = roots.some(root => [...names].some(name => stat(join(root, name)) !== undefined))

  if (manifestChanged || workspaceChanged || packageResidue) remove(join(profile, 'pnpm-lock.yaml'))
  if (manifestChanged) writeFileSync(manifestPath, `${JSON.stringify(manifest, undefined, 2)}\n`)
  if (workspaceChanged) writeFileSync(workspacePath, dump(workspace, { lineWidth: -1, noRefs: true }))
  for (const root of roots) for (const name of names) remove(join(root, name))
  writeFileSync(markerPath, `${JSON.stringify({ schemaVersion: 1 })}\n`, { flag: 'wx', mode: 0o600 })
}
