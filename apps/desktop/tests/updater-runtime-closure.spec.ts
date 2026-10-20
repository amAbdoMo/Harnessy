import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, it } from 'vitest'
import {
  stageUpdaterRuntimeClosure, updaterRuntimeClosure, verifyUpdaterRuntimeClosure,
} from '../scripts/updater-runtime-closure.mjs'

const APP_DIRECTORY = fileURLToPath(new URL('..', import.meta.url))
const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

it('resolves the auto-updater closure, including the packages the packager dropped', () => {
  const closure = updaterRuntimeClosure(APP_DIRECTORY)
  const names = closure.map(member => member.name)
  expect(names).toContain('electron-updater')
  expect(names).toContain('builder-util-runtime')
  // electron-builder's pnpm collection dropped these two from the packaged application.
  expect(names).toContain('debug')
  expect(names).toContain('ms')
  for (const member of closure) {
    const manifest = JSON.parse(readFileSync(join(member.directory, 'package.json'), 'utf8')) as { name: string }
    expect(manifest.name).toBe(member.name)
  }
})

it('stages every closure member with its own package files', () => {
  const closure = updaterRuntimeClosure(APP_DIRECTORY)
  const staging = mkdtempSync(join(tmpdir(), 'desktop-updater-closure-'))
  roots.push(staging)
  const staged = stageUpdaterRuntimeClosure(closure, staging)
  expect(staged.map(member => member.name)).toEqual(closure.map(member => member.name))
  for (const member of staged) {
    expect(existsSync(join(member.directory, 'package.json'))).toBe(true)
  }
  expect(existsSync(join(staging, 'debug', 'src', 'node.js'))).toBe(true)
})

it('rejects a packaged application that omits an updater runtime package', () => {
  const closure = [{ name: 'debug' }, { name: 'ms' }]
  const complete = { getFile: () => ({ size: 1 }) }
  expect(() => { verifyUpdaterRuntimeClosure(complete, closure) }).not.toThrow()
  const missing = { getFile: (path: string) => (path.includes('ms') ? undefined : { size: 1 }) }
  expect(() => { verifyUpdaterRuntimeClosure(missing, closure) }).toThrow(/missing .*ms/u)
  const unreadable = { getFile: () => { throw new Error('ENOENT') } }
  expect(() => { verifyUpdaterRuntimeClosure(unreadable, closure) }).toThrow(/cannot read/u)
})
