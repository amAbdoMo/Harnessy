/** Carry applicable workspace dependency patches into Desktop's private production install. */
import { appendFileSync, copyFileSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { dump, load } from 'js-yaml'

function isYamlMapping(candidate: unknown): candidate is Record<string, unknown> {
  if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) return false
  const prototype: unknown = Object.getPrototypeOf(candidate)
  return prototype === Object.prototype || prototype === null
}

function mappingField(path: string, field: string): Record<string, unknown> {
  const document: unknown = load(readFileSync(path, 'utf8'))
  if (!isYamlMapping(document)) throw new Error(`desktop runtime: invalid YAML ${path}`)
  const mapping = document[field]
  if (mapping === undefined) return {}
  if (!isYamlMapping(mapping)) throw new Error(`desktop runtime: invalid ${field}`)
  return mapping
}

function stagePatchFile(projectDir: string, workspaceRoot: string, patch: unknown): string {
  if (typeof patch !== 'string' || patch.length === 0) throw new Error('desktop runtime: dependency patch must name a file')
  const source = resolve(workspaceRoot, patch)
  const path = relative(workspaceRoot, source)
  if (isAbsolute(path) || path === '..' || path.startsWith(`..${sep}`)) throw new Error('desktop runtime: dependency patch escapes workspace')
  const target = join(projectDir, path)
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 })
  copyFileSync(source, target)
  return path.split(sep).join('/')
}

/**
 * Stage exact-version workspace patches selected by the resolved production lockfile.
 * @param projectDir - Private materialization project with an initial lockfile and generated workspace settings.
 * @param workspaceRoot - Source checkout declaring the patches.
 * @returns Whether patches were staged, requiring lockfile resolution before the frozen install.
 */
export function stageRuntimeDependencyPatches(projectDir: string, workspaceRoot: string): boolean {
  const patches = mappingField(join(workspaceRoot, 'pnpm-workspace.yaml'), 'patchedDependencies')
  const packages = mappingField(join(projectDir, 'pnpm-lock.yaml'), 'packages')
  const selected: Record<string, string> = {}
  for (const [selector, patch] of Object.entries(patches)) {
    if (Object.hasOwn(packages, selector)) selected[selector] = stagePatchFile(projectDir, workspaceRoot, patch)
  }
  if (Object.keys(selected).length === 0) return false
  appendFileSync(join(projectDir, 'pnpm-workspace.yaml'), `\n${dump({ patchedDependencies: selected }, { lineWidth: -1 })}`)
  console.info(`desktop runtime: staged dependency patches: ${Object.keys(selected).join(', ')}`)
  return true
}
