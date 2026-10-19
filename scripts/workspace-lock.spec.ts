/** Workspace lockfile links must survive relocating the checkout. */
import { readFileSync } from 'node:fs'
import { isAbsolute, posix, resolve, win32 } from 'node:path'
import { load } from 'js-yaml'
import { z } from 'zod'
import { expect, it } from 'vitest'

const root = resolve(import.meta.dirname, '..')
const dependency = z.object({ specifier: z.string(), version: z.string() })
const lock = z.object({
  overrides: z.record(z.string(), z.string()),
  importers: z.record(z.string(), z.record(z.string(), z.record(z.string(), dependency))),
}).parse(load(readFileSync(resolve(root, 'pnpm-lock.yaml'), 'utf8')))
const manifest = z.object({
  name: z.string(),
  devDependencies: z.record(z.string(), z.string()).optional(),
})

it('resolves every workspace link relative to its importer rather than a machine-specific checkout', () => {
  for (const [importer, sections] of Object.entries(lock.importers)) {
    for (const entries of Object.values(sections)) {
      for (const [name, entry] of Object.entries(entries)) {
        if (!entry.version.startsWith('link:')) continue
        const target = entry.version.slice('link:'.length)
        expect(isAbsolute(target) || win32.isAbsolute(target), `${importer}: ${name}`).toBe(false)
        expect(target, `${importer}: ${name}`).not.toContain('\\')
        const linked = manifest.parse(JSON.parse(readFileSync(resolve(root, importer, target, 'package.json'), 'utf8')))
        expect(linked.name, `${importer}: ${name}`).toBe(name)
      }
    }
  }
})

it('records importer-relative specifiers for workspace link overrides', () => {
  for (const [importer, sections] of Object.entries(lock.importers)) {
    for (const entries of Object.values(sections)) {
      for (const [name, entry] of Object.entries(entries)) {
        const override = lock.overrides[name]
        if (!override?.startsWith('link:')) continue
        expect(entry.specifier, `${importer}: ${name}`).toBe(`link:${posix.relative(importer, override.slice('link:'.length))}`)
      }
    }
  }
})

it('records every root workspace development dependency with its declared range', () => {
  const rootManifest = manifest.parse(JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')))
  for (const [name, specifier] of Object.entries(rootManifest.devDependencies ?? {})) {
    if (!specifier.startsWith('workspace:')) continue
    const entry = lock.importers['.']?.devDependencies?.[name]
    expect(entry, name).toBeDefined()
    expect(entry?.specifier, name).toBe(specifier)
    expect(entry?.version, name).toMatch(/^link:/u)
  }
})
