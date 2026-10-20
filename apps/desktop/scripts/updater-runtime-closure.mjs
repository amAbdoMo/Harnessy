/** Resolve the auto-updater's runtime package closure for the packaged Desktop application. */
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

/**
 * Locate one installed package directory through Node's own resolution.
 * @param {string} fromDirectory Directory whose `node_modules` chain is searched.
 * @param {string} name Package name to locate.
 * @returns {string} Absolute package root directory.
 */
function resolvePackageDirectory(fromDirectory, name) {
  const require = createRequire(join(fromDirectory, 'package.json'))
  let entry
  try {
    entry = require.resolve(name)
  } catch (error) {
    throw new Error(`desktop updater: cannot resolve ${name} from ${fromDirectory}: ${error.message}`)
  }
  let directory = dirname(entry)
  for (;;) {
    const manifestPath = join(directory, 'package.json')
    if (existsSync(manifestPath)) {
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
      if (manifest.name === name) return directory
    }
    const parent = dirname(directory)
    if (parent === directory) throw new Error(`desktop updater: cannot locate the package root of ${name}`)
    directory = parent
  }
}

/**
 * Collect the auto-updater's runtime packages and their transitive dependencies.
 * electron-builder's pnpm production collection can drop a package that the workspace
 * reports only as a duplicated reference, so the packaged application must carry this
 * closure itself.
 * @param {string} appDirectory Desktop application directory owning the install.
 * @returns {{ name: string, directory: string }[]} Closure members ordered by name.
 */
export function updaterRuntimeClosure(appDirectory) {
  const found = new Map()
  const visit = (directory, name) => {
    if (found.has(name)) return
    found.set(name, directory)
    const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'))
    for (const dependency of Object.keys(manifest.dependencies ?? {})) {
      visit(resolvePackageDirectory(directory, dependency), dependency)
    }
  }
  visit(resolvePackageDirectory(appDirectory, 'electron-updater'), 'electron-updater')
  return [...found].map(([name, directory]) => ({ name, directory }))
    .sort((left, right) => left.name.localeCompare(right.name))
}

/**
 * Copy the closure into a staging directory inside the application directory.
 * @param {{ name: string, directory: string }[]} closure Closure members to stage.
 * @param {string} stagingDirectory Empty directory that receives one package per member.
 * @returns {{ name: string, directory: string }[]} Staged closure members.
 */
export function stageUpdaterRuntimeClosure(closure, stagingDirectory) {
  rmSync(stagingDirectory, { recursive: true, force: true })
  mkdirSync(stagingDirectory, { recursive: true })
  return closure.map(member => {
    const target = join(stagingDirectory, member.name)
    cpSync(member.directory, target, { recursive: true, dereference: true })
    return { name: member.name, directory: target }
  })
}

/**
 * Reject a packaged application whose archive omits an updater runtime package.
 * @param {{ getFile: (path: string, followLinks: boolean) => { size: number } | undefined }} archive Packaged archive reader.
 * @param {{ name: string }[]} closure Closure members the archive must contain.
 * @returns {void}
 */
export function verifyUpdaterRuntimeClosure(archive, closure) {
  for (const member of closure) {
    const path = join('node_modules', member.name, 'package.json')
    let entry
    try {
      entry = archive.getFile(path, false)
    } catch (error) {
      throw new Error(`desktop updater: the packaged application cannot read ${path}: ${error.message}`)
    }
    if (entry === undefined || entry === null) {
      throw new Error(`desktop updater: the packaged application is missing ${path}`)
    }
  }
}
