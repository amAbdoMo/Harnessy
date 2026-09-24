import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  commandCodeCatalogPath,
  commandsCodeRouteOwns,
  createCommandCodeCapabilitySource,
  installedCommandCodeEntryPoint,
  loadCommandCodeModelEfforts,
  parseCommandCodeModelEfforts,
  resolveCommandCodeEntryPoint,
} from '../src/models.ts'

/** Every temporary package tree a case built, removed afterwards. */
const trees: string[] = []

afterEach(() => {
  for (const tree of trees.splice(0)) rmSync(tree, { recursive: true, force: true })
})

/**
 * A package tree laid out like the installed CLI: an entry point and the
 * catalog its shipped knowledge directory carries.
 * @param markdown - the catalog text, or undefined to ship none.
 * @returns the entry point path.
 */
function installedTree(markdown: string | undefined): string {
  const root = mkdtempSync(join(tmpdir(), 'commandcode-models-'))
  trees.push(root)
  const dist = join(root, 'dist')
  const reference = join(dist, 'bundled', 'command-code-knowledge', 'reference')
  mkdirSync(reference, { recursive: true })
  if (markdown !== undefined) writeFileSync(join(reference, 'models.md'), markdown, 'utf8')
  const entry = join(dist, 'index.mjs')
  writeFileSync(entry, '// entry\n', 'utf8')
  return entry
}

/** A catalog shaped like the generated one, with two described models and one that decides for itself. */
const CATALOG = [
  '| Id (use EXACTLY this) | Name | Context | Efforts | $/1M in/out | Min plan | Best for |',
  '|---|---|---|---|---|---|---|',
  '| `deepseek/deepseek-v4.1-flash` | DeepSeek V4.1 Flash | 1M | low, high, max | $0.15/$0.6 | Go and above | V4.1 reasoning |',
  '| `Qwen/Qwen3.8-Flash` | Qwen 3.8 Flash | 1M | low, medium, xhigh | $0.16/$0.47 | Go and above | fast agentic coding |',
  '| `deepseek/deepseek-v4-pro` | DeepSeek V4 Pro | 1M | high, max | $0.66/$1.98 | Go and above | long-context reasoning |',
  '| `claude-haiku-4-5-20251001` | Claude Haiku 4.5 | 200K | — | $1/$5 | Pro and above | fastest |',
  '',
  'Models without an effort column entry decide their own reasoning depth.',
].join('\n')

describe('Command Code model catalog', () => {
  it('preserves the exact per-model level set, and states none where the catalog states none', () => {
    const efforts = parseCommandCodeModelEfforts(CATALOG)

    // The exact sets Command Code records, including the ones that are not
    // low/medium/high: a provider-wide assumption would be wrong here.
    expect(efforts.get('deepseek/deepseek-v4.1-flash')).toEqual(['low', 'high', 'max'])
    expect(efforts.get('Qwen/Qwen3.8-Flash')).toEqual(['low', 'medium', 'xhigh'])
    expect(efforts.get('deepseek/deepseek-v4-pro')).toEqual(['high', 'max'])
    // A dash is the catalog stating the model decides its own depth, which is
    // not an offer of `off` or of anything else.
    expect(efforts.has('claude-haiku-4-5-20251001')).toBe(false)
    // Headings, the separator row, and prose contribute nothing.
    expect([...efforts.keys()]).toHaveLength(3)
  })

  it('keeps a level it has never heard of rather than translating or dropping it', () => {
    const efforts = parseCommandCodeModelEfforts([
      '| `vendor/model` | M | 1M | minimal, ultra , low | $1 | Plan | best |',
    ].join('\n'))
    // Normalization belongs to the seam, not to this reader: a spelling this
    // build cannot honour must stay visible rather than be silently rewritten.
    expect(efforts.get('vendor/model')).toEqual(['minimal', 'ultra', 'low'])
  })

  it('skips rows without a backticked id or the columns the catalog is read by', () => {
    const efforts = parseCommandCodeModelEfforts([
      'not a row',
      '| no-backticks | M | 1M | low | $1 | Plan | best |',
      // Too few cells to hold the id and effort columns.
      '| `truncated` | M |',
      '| `empty-efforts` | M | 1M | — |',
      '| `kept/row` | M | 1M | low |',
    ].join('\n'))
    expect([...efforts.keys()]).toEqual(['kept/row'])
  })

  it('reads the catalog from the shipped knowledge directory, and reports its absence', () => {
    const withCatalog = installedTree(CATALOG)
    expect(commandCodeCatalogPath(withCatalog)).toBeDefined()
    expect(loadCommandCodeModelEfforts(withCatalog).get('z-ai/glm-5.3-flash')).toBeUndefined()
    expect(loadCommandCodeModelEfforts(withCatalog).get('deepseek/deepseek-v4.1-flash'))
      .toEqual(['low', 'high', 'max'])

    const withoutCatalog = installedTree(undefined)
    expect(commandCodeCatalogPath(withoutCatalog)).toBeUndefined()
    // A package that ships no catalog leaves every model undeclared.
    expect(loadCommandCodeModelEfforts(withoutCatalog).size).toBe(0)
  })

  it('treats a catalog it cannot read as one that states nothing', () => {
    // A directory where the catalog belongs: `existsSync` accepts the path and
    // the read fails, which must stay a missing answer rather than a throw.
    const entry = installedTree(undefined)
    mkdirSync(join(dirname(entry), 'bundled', 'command-code-knowledge', 'reference', 'models.md'),
      { recursive: true })
    expect(commandCodeCatalogPath(entry)).toBeDefined()
    expect(loadCommandCodeModelEfforts(entry).size).toBe(0)
  })

  it('resolves the entry point on each platform from the launcher it finds', () => {
    const entry = installedTree(CATALOG)
    // Windows: the npm shim names the JavaScript entry it launches.
    const shim = join(dirname(entry), 'cmdc.cmd')
    const shimText = `@ECHO off\r\n"%_prog%"  "${entry}" %*\r\n`
    expect(resolveCommandCodeEntryPoint('win32', {
      pathEntries: ['C:\\empty', dirname(entry)],
      exists: path => path === shim,
      readText: () => shimText,
      realpath: path => path,
    })).toBe(entry)
    // Window: an installed launcher that names no entry resolves to nothing.
    expect(resolveCommandCodeEntryPoint('win32', {
      pathEntries: [dirname(entry)],
      exists: () => true,
      readText: () => '@ECHO off\r\n',
      realpath: path => path,
    })).toBeUndefined()

    // POSIX: the PATH entry is followed to the package the catalog proves it is.
    const bin = join(dirname(dirname(entry)), 'bin')
    expect(resolveCommandCodeEntryPoint('linux', {
      pathEntries: ['', bin],
      exists: path => path === join(bin, 'cmd') || path.startsWith(entry),
      readText: () => '',
      realpath: () => entry,
    })).toBe(entry)
    // A link that cannot be followed, and a `cmd` that resolves to a program
    // shipping no such catalog, both leave the entry point unresolved.
    expect(resolveCommandCodeEntryPoint('linux', {
      pathEntries: [bin],
      exists: () => true,
      readText: () => '',
      realpath: () => { throw new Error('broken link') },
    })).toBeUndefined()
    const foreign = installedTree(undefined)
    expect(resolveCommandCodeEntryPoint('linux', {
      pathEntries: [dirname(foreign)],
      exists: () => true,
      readText: () => '',
      realpath: () => foreign,
    })).toBeUndefined()
    expect(resolveCommandCodeEntryPoint('linux', {
      pathEntries: [dirname(entry)],
      exists: () => false,
      readText: () => '',
      realpath: path => path,
    })).toBeUndefined()
  })

  it('owns a route only when the route names Command Code', () => {
    expect(commandsCodeRouteOwns({ baseURL: 'https://api.commandcode.ai/v1' })).toBe(true)
    expect(commandsCodeRouteOwns({ baseURL: 'https://staging-api.commandcode.ai/v1' })).toBe(true)
    expect(commandsCodeRouteOwns({ provider: 'commandcode' })).toBe(true)
    expect(commandsCodeRouteOwns({ provider: 'command-code' })).toBe(true)
    expect(commandsCodeRouteOwns({ provider: 'cmdc' })).toBe(true)
    // A gateway serving a bare id that Command Code also serves must not
    // inherit Command Code's numbers.
    expect(commandsCodeRouteOwns({ provider: 'anthropic', baseURL: 'https://api.anthropic.com' })).toBe(false)
    expect(commandsCodeRouteOwns({ baseURL: 'https://gateway.example/v1' })).toBe(false)
    expect(commandsCodeRouteOwns({ provider: 'commandcode', baseURL: 'not a url' })).toBe(true)
    expect(commandsCodeRouteOwns({})).toBe(false)
  })

  it('answers per model for an owned route and nothing for any other', () => {
    const source = createCommandCodeCapabilitySource(() => installedTree(CATALOG))
    const commandCode = { provider: 'commandcode', baseURL: 'https://api.commandcode.ai/v1' }

    expect(source('deepseek/deepseek-v4.1-flash', commandCode))
      .toEqual({ reasoningEfforts: ['low', 'high', 'max'] })
    expect(source('Qwen/Qwen3.8-Flash', commandCode))
      .toEqual({ reasoningEfforts: ['low', 'medium', 'xhigh'] })
    // The catalog states nothing for this one, so the source states nothing.
    expect(source('claude-haiku-4-5-20251001', commandCode)).toBeUndefined()
    expect(source('model-the-catalog-never-heard-of', commandCode)).toBeUndefined()
    // Same id, different provider: this source does not own that route.
    expect(source('deepseek/deepseek-v4.1-flash', { provider: 'acme', baseURL: 'https://acme.test/v1' }))
      .toBeUndefined()
  })

  it('answers nothing when no CLI is installed, and reads the catalog once', () => {
    expect(createCommandCodeCapabilitySource(() => undefined)(
      'deepseek/deepseek-v4.1-flash',
      { provider: 'commandcode' },
    )).toBeUndefined()

    const entryPoint = installedTree(CATALOG)
    const resolve = vi.fn(() => entryPoint)
    const source = createCommandCodeCapabilitySource(resolve)
    expect(source('deepseek/deepseek-v4.1-flash', { provider: 'commandcode' }))
      .toEqual({ reasoningEfforts: ['low', 'high', 'max'] })
    expect(source('deepseek/deepseek-v4-pro', { provider: 'commandcode' }))
      .toEqual({ reasoningEfforts: ['high', 'max'] })
    // Resolving PATH entries once per plugin lifetime, not once per model.
    expect(resolve).toHaveBeenCalledTimes(1)
    // A route this source does not own never even resolves the installation.
    expect(source('deepseek/deepseek-v4-pro', { provider: 'acme' })).toBeUndefined()
    expect(resolve).toHaveBeenCalledTimes(1)
  })

  it('resolves this machine\'s installation when one is present', () => {
    // The zero-argument resolver reads the running process's own PATH; on a
    // machine without the CLI it proves nothing and must answer undefined
    // rather than throwing.
    const entry = installedCommandCodeEntryPoint()
    if (entry !== undefined) expect(existsSync(entry)).toBe(true)
  })

  it('drives both platforms through the process filesystem adapters', () => {
    const entry = installedTree(CATALOG)
    const original = process.env.PATH
    try {
      // A PATH holding the launcher a POSIX install exposes: the link is
      // followed, and the catalog beside it proves which package it is.
      const bin = join(dirname(entry), 'bin')
      mkdirSync(bin, { recursive: true })
      writeFileSync(join(bin, 'cmd'), '', 'utf8')
      process.env.PATH = bin
      expect(installedCommandCodeEntryPoint('linux')).toBeUndefined()

      // A PATH holding the npm shim a Windows install exposes: the shim is read
      // for the entry it launches.
      writeFileSync(join(bin, 'cmdc.cmd'), `@ECHO off\r\n"%_prog%"  "${entry}" %*\r\n`, 'utf8')
      expect(installedCommandCodeEntryPoint('win32')).toBe(entry)

      // A process with no PATH at all resolves nothing, and must not throw.
      Reflect.deleteProperty(process.env, 'PATH')
      expect(installedCommandCodeEntryPoint('linux')).toBeUndefined()
    } finally {
      if (original === undefined) Reflect.deleteProperty(process.env, 'PATH')
      else process.env.PATH = original
    }
  })

  it('reports a route whose endpoint is not a URL as one it does not own', () => {
    expect(commandsCodeRouteOwns({ baseURL: 'not a url' })).toBe(false)
  })
})
