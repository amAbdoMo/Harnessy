/** Shared schema aliases must retain the catalog's declared-field checks. */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { collectConfigCatalog, render, type CatalogEntry } from './gen-config-catalog.ts'
import { computeTranslationPairingRecord, translationPairPaths } from './translation-pairing-record.ts'
import { generatedRegions } from './translation-pairing.ts'

const roots: string[] = []
const sharedSchema = `
import Schema from '@deepseek-ai/schemastery'
export interface LaunchConfig {
  /** Browser ownership mode. */
  mode: 'launch'
  /** Hide the launched browser. */
  headless: boolean
}
export interface AttachConfig {
  /** Browser ownership mode. */
  mode: 'attach'
  /** Existing browser address. */
  endpoint: string
}
export type BrowserConfig = LaunchConfig | AttachConfig
export const Shared = Schema.union([
  Schema.object({ mode: Schema.const('launch'), headless: Schema.boolean() }),
  Schema.object({ mode: Schema.const('attach'), endpoint: Schema.string() }),
])
`

function fixture(schema = sharedSchema) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-config-catalog-'))
  roots.push(root)
  const write = (path: string, value: string): void => {
    const file = join(root, path)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, value)
  }
  write('tsconfig.json', JSON.stringify({ compilerOptions: {
    baseUrl: '.', module: 'ESNext', moduleResolution: 'Bundler',
    paths: { '@test/runtime/config': ['./packages/test/runtime/src/config.ts'] },
  }, include: ['packages/**/*.ts'] }))
  write('packages/test/runtime/package.json', JSON.stringify({
    name: '@test/runtime', exports: { './config': { types: './lib/types/config.d.ts', default: './lib/config.js' } },
  }))
  write('packages/test/runtime/src/index.ts', "export { Shared } from './config.ts'\n")
  write('packages/test/runtime/src/config.ts', schema)
  write('packages/test/provider/package.json', JSON.stringify({ name: '@test/provider' }))
  write('packages/test/provider/src/index.ts', `
import { Shared as SharedConfig, type BrowserConfig } from '@test/runtime/config'
export type Config = BrowserConfig
export const Config = SharedConfig
export function apply(ctx: unknown, config: Config): void {}
`)
  return { root, write }
}

const localSchema = `
import Schema from '@deepseek-ai/schemastery'
export interface Config {
  /** Relay address. */
  endpoint: string
}
export const Config = Schema.object({ endpoint: Schema.string() })
`

function localFixture(schema = localSchema, specifier = './config.ts') {
  const { root, write } = fixture()
  write('packages/test/provider/src/config.ts', schema)
  write('packages/test/provider/src/index.ts', `
import type { Config } from './config.ts'
import { Config as RuntimeConfig } from '${specifier}'
export default class Provider {
  static Config = RuntimeConfig
  constructor(ctx: unknown, config: Config) {}
}
`)
  return { root, write }
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('shared config schema catalog', () => {
  it('collects every branch through a renamed named import from a public source subpath', () => {
    const { root } = fixture()
    const provider = collectConfigCatalog(root).find(entry => entry.pkg === '@test/provider')
    expect(new Set(provider?.schemaKeys)).toEqual(new Set(['mode', 'headless', 'endpoint']))
    expect(provider?.configTypeName).toBe('Config')
    expect(provider?.pastes?.[0]?.text).toBe('export type Config = BrowserConfig')
  })

  it('rejects a schema field absent from the shared config type', () => {
    const { root } = fixture(sharedSchema.replace('headless: Schema.boolean()', 'headless: Schema.boolean(), hidden: Schema.string()'))
    expect(() => collectConfigCatalog(root)).toThrow("schema validates key 'hidden' but config type 'Config' declares no such member")
  })

  it('follows a local const alias without treating a completed branch as a cycle', () => {
    const { root } = fixture(sharedSchema.replace('export const Shared = Schema.union', 'export const Shared = Base\nconst Base = Schema.union'))
    const provider = collectConfigCatalog(root).find(entry => entry.pkg === '@test/provider')
    expect(new Set(provider?.schemaKeys)).toEqual(new Set(['mode', 'headless', 'endpoint']))
  })

  it('rejects type-only imports used as runtime schemas', () => {
    const { root, write } = fixture()
    write('packages/test/provider/src/index.ts', `
import type { Shared as SharedConfig, BrowserConfig } from '@test/runtime/config'
export type Config = BrowserConfig
export const Config = SharedConfig
export function apply(ctx: unknown, config: Config): void {}
`)
    expect(() => collectConfigCatalog(root)).toThrow("schema alias 'SharedConfig' must name a const or named value import")
  })

  it('rejects a private subpath even when TypeScript can resolve its source', () => {
    const { root, write } = fixture()
    write('packages/test/runtime/package.json', JSON.stringify({ name: '@test/runtime', exports: {} }))
    expect(() => collectConfigCatalog(root)).toThrow("does not explicitly export './config'")
  })

  it('rejects a missing source mapping', () => {
    const { root, write } = fixture()
    write('tsconfig.json', JSON.stringify({ compilerOptions: { paths: { '@test/runtime/config': ['./missing.ts'] } } }))
    expect(() => collectConfigCatalog(root)).toThrow('has no workspace source mapping')
  })

  it('rejects a source mapping into another package', () => {
    const { root, write } = fixture()
    write('tsconfig.json', JSON.stringify({ compilerOptions: {
      baseUrl: '.', paths: { '@test/runtime/config': ['./packages/test/provider/src/index.ts'] },
    } }))
    expect(() => collectConfigCatalog(root)).toThrow('must resolve inside packages/test/runtime/src')
  })

  it('rejects a schema value that the imported module does not export', () => {
    const { root } = fixture(sharedSchema.replace('export const Shared', 'const Shared'))
    expect(() => collectConfigCatalog(root)).toThrow("has no exported const 'Shared'")
  })

  it('rejects recursive const aliases', () => {
    const { root } = fixture(`${sharedSchema.slice(0, sharedSchema.indexOf('export const Shared'))}
export const Shared = Loop
const Loop = Shared
`)
    expect(() => collectConfigCatalog(root)).toThrow('cyclic schema alias')
  })

  it('rejects a dynamic schema factory instead of dropping its keys', () => {
    const { root } = fixture(`${sharedSchema.slice(0, sharedSchema.indexOf('export const Shared'))}
export const Shared = makeSchema()
`)
    expect(() => collectConfigCatalog(root)).toThrow('not a statically walkable schemastery call')
  })

  it('rejects an unresolved alias within a schema union', () => {
    const { root } = fixture(`${sharedSchema.slice(0, sharedSchema.indexOf('export const Shared'))}
export const Shared = Schema.union([MissingSchema])
`)
    expect(() => collectConfigCatalog(root)).toThrow("schema alias 'MissingSchema' must name a const or named value import")
  })
})

describe('package-local config schema catalog', () => {
  it('collects a class static schema from a renamed named import in its own src', () => {
    const { root } = localFixture()
    const provider = collectConfigCatalog(root).find(entry => entry.pkg === '@test/provider')
    expect(provider?.schemaKeys).toEqual(['endpoint'])
    expect(provider?.schemaComposes).toEqual([])
    expect(provider?.pastes?.[0]?.source).toBe('packages/test/provider/src/config.ts:3')
  })

  it('follows relative schema aliases between nested src files without cycling on repeated branches', () => {
    const { root, write } = localFixture(localSchema.replace(
      'export const Config = Schema.object({ endpoint: Schema.string() })',
      "import { Shared } from './nested/schema.ts'\nexport const Config = Schema.union([Shared, Shared])",
    ))
    write('packages/test/provider/src/nested/schema.ts', `
import { Base as ImportedBase } from '../base.ts'
export const Shared = BaseSchema
const BaseSchema = ImportedBase
`)
    write('packages/test/provider/src/base.ts', "import Schema from '@deepseek-ai/schemastery'\nexport const Base = Schema.object({ endpoint: Schema.string() })\n")
    const provider = collectConfigCatalog(root).find(entry => entry.pkg === '@test/provider')
    expect(provider?.schemaKeys).toEqual(['endpoint', 'endpoint'])
  })

  it('rejects a local schema field absent from the config declaration', () => {
    const { root } = localFixture(localSchema.replace('endpoint: Schema.string()', 'endpoint: Schema.string(), hidden: Schema.string()'))
    expect(() => collectConfigCatalog(root)).toThrow("schema validates key 'hidden' but config type 'Config' declares no such member")
  })

  it.each([
    '../config.ts',
    '../../runtime/src/config.ts',
    '../src-other/config.ts',
    './config',
    './config.js',
    './schema.d.ts',
  ])('rejects relative schema target %s outside the owning src or without a source .ts extension', (specifier) => {
    const { root, write } = localFixture(localSchema, specifier)
    write(join('packages/test/provider/src', specifier), localSchema)
    expect(() => collectConfigCatalog(root)).toThrow(`schema import '${specifier}' must resolve inside packages/test/provider/src to a TypeScript source file`)
  })

  it('rejects a missing relative schema source', () => {
    const { root } = localFixture(localSchema, './missing.ts')
    expect(() => collectConfigCatalog(root)).toThrow("schema import './missing.ts' does not exist")
  })

  it.each(['const Config', 'export let Config', 'export const Other'])('rejects a local imported schema declared as %s instead of an exported const Config', (declaration) => {
    const { root } = localFixture(localSchema.replace('export const Config', declaration))
    expect(() => collectConfigCatalog(root)).toThrow("schema import './config.ts' has no exported const 'Config'")
  })

  it('rejects cyclic schema aliases across relative imports', () => {
    const { root, write } = localFixture(localSchema.replace(
      'export const Config = Schema.object({ endpoint: Schema.string() })',
      "import { Shared } from './nested/schema.ts'\nexport const Config = Shared",
    ))
    write('packages/test/provider/src/nested/schema.ts', "import { Config } from '../config.ts'\nexport const Shared = Config\n")
    expect(() => collectConfigCatalog(root)).toThrow('cyclic schema alias')
  })
})

describe('config catalog rendering', () => {
  const entries = (inject: string[]): CatalogEntry[] => [
    {
      pkg: '@deepseek-ai/dsh-demo',
      dir: 'packages/demo/demo',
      entry: 'packages/demo/demo/src/index.ts',
      kind: 'config',
      inject,
      pastes: [{ text: 'export interface DemoConfig {}', source: 'packages/demo/demo/src/index.ts:3' }],
    },
    { pkg: '@deepseek-ai/dsh-plain', dir: 'packages/demo/plain', entry: 'packages/demo/plain/src/index.ts', kind: 'no-config', inject },
  ]
  const paths = translationPairPaths('docs/config-catalog.md')
  const record = (inject: string[]) => computeTranslationPairingRecord(
    paths,
    render(entries(inject), 'en'),
    render(entries(inject), 'zh'),
    { repoRoot: process.cwd(), isTranslationPairSource: () => false },
  )

  it('keeps package data in generated regions shared by both languages', () => {
    const en = generatedRegions(render(entries(['jobs']), 'en')).map(region => region.text)
    expect(en.map(region => region.split('\n')[0])).toEqual([
      '<!-- BEGIN GENERATED config-catalog:@deepseek-ai/dsh-demo -->',
      '<!-- BEGIN GENERATED config-catalog:no-config -->',
      '<!-- BEGIN GENERATED config-catalog:seam -->',
      '<!-- BEGIN GENERATED config-catalog:library -->',
    ])
    expect(generatedRegions(render(entries(['jobs']), 'zh')).map(region => region.text)).toEqual(en)
    expect(en[0]).toContain('- `inject`: `jobs`')
  })

  it('leaves the consistency record unchanged when only package data changes', () => {
    expect(record(['jobs', 'typert'])).toEqual(record(['jobs']))
    expect([...record(['jobs']).keys()].some(key => key.includes('dsh-demo'))).toBe(false)
  })
})
