/** Remove upstream NumPy/pandas test suites only from private build staging. */

import { lstatSync, readFileSync, readdirSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path'
import Papa from 'papaparse'
import lock from './lock.json' with { type: 'json' }

function requireStagedDirectory(staging: string, directory: string): void {
  const path = relative(staging, directory)
  if (isAbsolute(path) || path === '..' || path.startsWith(`..${sep}`)) {
    throw new Error(`primary runtime: directory outside private staging: ${directory}`)
  }
  let current = staging
  for (const part of ['', ...path.split(sep).filter(Boolean)]) {
    current = join(current, part)
    const entry = lstatSync(current)
    if (entry.isSymbolicLink() || !entry.isDirectory()) {
      throw new Error(`primary runtime: expected unlinked staged directory: ${current}`)
    }
  }
}

function testDirectories(root: string, directory: string): string[] {
  return readdirSync(join(root, directory), { withFileTypes: true }).flatMap((entry) => {
    if (entry.isSymbolicLink() || !entry.isDirectory()) return []
    const path = `${directory}/${entry.name}`
    return entry.name === 'tests' ? [path] : testDirectories(root, path)
  })
}

function removeDirectory(directory: string): void {
  // Unlink junctions explicitly; recursive rm can follow them on Windows.
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry)
    const stat = lstatSync(path)
    if (stat.isDirectory() && !stat.isSymbolicLink()) removeDirectory(path)
    else unlinkSync(path)
  }
  rmdirSync(directory)
}

/**
 * Prune NumPy/pandas tests and rewrite their CSV RECORDs without changing retained files or hashes.
 * Both RECORDs are validated before deletion. Directory links are not followed; links inside a
 * removed real test directory are unlinked without touching their targets.
 * @param sitePackages - Extracted site-packages below the private staging directory, never an installed runtime.
 * @param stagingRoot - Exclusively owned temporary build directory; callers must prevent concurrent mutation.
 * @throws If staging contains linked path components or either locked distribution's RECORD is missing or malformed.
 */
export function prunePrimaryRuntimePythonTests(sitePackages: string, stagingRoot: string): void {
  const root = resolve(sitePackages), staging = resolve(stagingRoot)
  if (root === staging || basename(root) !== 'site-packages') {
    throw new Error(`primary runtime: expected staged site-packages: ${root}`)
  }
  requireStagedDirectory(staging, root)
  const plans = (['numpy', 'pandas'] as const).map((name) => {
    requireStagedDirectory(staging, join(root, name))
    const metadata = join(root, `${name}-${lock.pythonPackages[name]}.dist-info`)
    requireStagedDirectory(staging, metadata)
    const record = join(metadata, 'RECORD')
    const stat = lstatSync(record)
    if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1) {
      throw new Error(`primary runtime: expected private staged wheel RECORD: ${record}`)
    }
    const { data, errors } = Papa.parse<string[]>(readFileSync(record, 'utf8'), { delimiter: ',', skipEmptyLines: true })
    if (errors.length > 0 || data.length === 0
      || !data.every((row): row is [string, string, string] => row.length === 3 && Boolean(row[0]))) {
      throw new Error(`primary runtime: invalid wheel RECORD: ${record}`)
    }
    return { record, data, removed: testDirectories(root, name) }
  })
  for (const { record, data, removed } of plans) {
    if (removed.length === 0) continue
    for (const directory of removed) {
      const path = join(root, directory)
      requireStagedDirectory(staging, path)
      removeDirectory(path)
    }
    const retained = data.filter(([path]) => !removed.some(directory => path.startsWith(`${directory}/`)))
    writeFileSync(record, `${Papa.unparse(retained, { newline: '\n' })}\n`)
  }
}
