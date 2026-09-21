/** Prepare the disposable npm-project view used by an unpackaged Electron shell. */

import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
} from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { createDevelopmentProjectMetadata } from '../src/project-manager.ts'
import type { DesktopRelease } from '../src/release.ts'

interface PackageManifest {
  readonly name?: string
  readonly version?: string
}

/** Inputs whose locations differ between the launcher and isolated tests. */
export interface DevelopmentProjectOptions {
  /** Directory replaced with the generated development project. */
  readonly projectDir: string
  /** Current workspace's `apps/cli` package directory. */
  readonly cliDir: string
  /** Current workspace's private Desktop Host application directory. */
  readonly hostDir: string
  /** pnpm's workspace-wide virtual-hoist directory. */
  readonly dependencyDir: string
  /** Release identity written into the disposable project metadata. */
  readonly release: DesktopRelease
}

function readManifest(path: string): PackageManifest {
  return JSON.parse(readFileSync(path, 'utf8')) as PackageManifest
}

function removeOwnedPath(path: string): void {
  let stat: ReturnType<typeof lstatSync>
  try {
    stat = lstatSync(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  if (stat.isSymbolicLink()) {
    unlinkSync(path)
    return
  }
  if (stat.isDirectory()) {
    rmSync(path, { recursive: true })
    return
  }
  unlinkSync(path)
}

function linkDirectory(source: string, destination: string): void {
  mkdirSync(dirname(destination), { recursive: true })
  symlinkSync(realpathSync(source), destination, process.platform === 'win32' ? 'junction' : 'dir')
}

function linkWorkspaceDependency(source: string, destination: string): string | undefined {
  let resolved: string
  try {
    resolved = realpathSync(source)
  } catch (error) {
    // pnpm can leave a virtual-hoist link behind after its workspace package is
    // removed. It is not part of the current graph, so the disposable project
    // omits it; every other filesystem failure still aborts preparation.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
  if (!existsSync(destination)) {
    mkdirSync(dirname(destination), { recursive: true })
    symlinkSync(resolved, destination, process.platform === 'win32' ? 'junction' : 'dir')
  }
  return resolved
}

function mirrorDependencyLinks(sourceRoot: string, destinationRoot: string): readonly string[] {
  const resolved: string[] = []
  for (const entry of readdirSync(sourceRoot, { withFileTypes: true })) {
    if (entry.name === '.bin') continue
    const source = join(sourceRoot, entry.name)
    if (entry.name.startsWith('@') && (entry.isDirectory() || entry.isSymbolicLink())) {
      mkdirSync(join(destinationRoot, entry.name), { recursive: true })
      for (const scoped of readdirSync(source, { withFileTypes: true })) {
        if (!scoped.isDirectory() && !scoped.isSymbolicLink()) continue
        const linked = linkWorkspaceDependency(
          join(source, scoped.name),
          join(destinationRoot, entry.name, scoped.name),
        )
        if (linked !== undefined) resolved.push(linked)
      }
      continue
    }
    if (entry.isDirectory() || entry.isSymbolicLink()) {
      const linked = linkWorkspaceDependency(source, join(destinationRoot, entry.name))
      if (linked !== undefined) resolved.push(linked)
    }
  }
  return resolved
}

function isWorkspacePackage(candidate: string, workspaceRoot: string): boolean {
  const fromRoot = relative(workspaceRoot, candidate)
  return fromRoot !== ''
    && fromRoot !== '..'
    && !isAbsolute(fromRoot)
    && !fromRoot.startsWith(`..${sep}`)
    && !fromRoot.split(/[\\/]/u).includes('node_modules')
}

function mirrorTransitiveWorkspaceLinks(
  workspaceRoot: string,
  packageRoots: readonly string[],
  destinationRoot: string,
): void {
  const pending = [...packageRoots]
  const visited = new Set<string>()
  while (pending.length > 0) {
    const packageRoot = pending.shift()
    if (packageRoot === undefined) break
    const canonicalRoot = realpathSync(packageRoot)
    if (visited.has(canonicalRoot)) continue
    visited.add(canonicalRoot)
    const modules = join(canonicalRoot, 'node_modules')
    if (!existsSync(modules)) continue
    for (const dependency of mirrorDependencyLinks(modules, destinationRoot)) {
      if (isWorkspacePackage(dependency, workspaceRoot)) pending.push(dependency)
    }
  }
}

/**
 * Replace one disposable project with links to the current built workspace.
 * @param options - Project destination, CLI package, and release identity.
 * @returns the absolute project directory supplied by the caller.
 */
export function prepareDevelopmentProject(options: DevelopmentProjectOptions): string {
  const cliManifest = readManifest(join(options.cliDir, 'package.json'))
  if (cliManifest.name !== '@deepseek-ai/dsh' || cliManifest.version !== options.release.version) {
    throw new Error(
      `desktop development: apps/cli must be @deepseek-ai/dsh@${options.release.version}, found `
      + `${String(cliManifest.name)}@${String(cliManifest.version)}`,
    )
  }
  if (!existsSync(options.dependencyDir)) {
    throw new Error('desktop development: workspace dependency links are missing; run pnpm install')
  }
  const hostManifest = readManifest(join(options.hostDir, 'package.json'))
  if (hostManifest.name !== '@deepseek-ai/dsh-desktop-host' || hostManifest.version !== options.release.version) {
    throw new Error(
      `desktop development: apps/desktop-host must be @deepseek-ai/dsh-desktop-host@${options.release.version}, found `
      + `${String(hostManifest.name)}@${String(hostManifest.version)}`,
    )
  }
  if (!existsSync(join(options.hostDir, 'lib', 'index.js'))) {
    throw new Error('desktop development: apps/desktop-host/lib/index.js is missing; run pnpm run build')
  }

  removeOwnedPath(options.projectDir)
  createDevelopmentProjectMetadata(options.projectDir, options.release)
  const destinationModules = join(options.projectDir, 'node_modules')
  mkdirSync(destinationModules, { recursive: true })
  mirrorDependencyLinks(options.dependencyDir, destinationModules)
  mirrorTransitiveWorkspaceLinks(resolve(options.cliDir, '..', '..'), [options.cliDir, options.hostDir], destinationModules)
  const dshLink = join(destinationModules, '@deepseek-ai', 'dsh')
  removeOwnedPath(dshLink)
  linkDirectory(options.cliDir, dshLink)
  const hostLink = join(destinationModules, '@deepseek-ai', 'dsh-desktop-host')
  removeOwnedPath(hostLink)
  linkDirectory(options.hostDir, hostLink)
  return options.projectDir
}
