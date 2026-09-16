import { describe, expect, it } from 'vitest'
import {
  parseModelCatalog,
  probeCommandCode,
  readCommandCodeCatalog,
  resolveCommandCodeInvocation,
  windowsShimEntry,
} from '../src/cli.ts'
import type { CommandCodeProcessResult, CommandCodeRunner } from '../src/cli.ts'

/** The installed CLI's reported executable name on this platform. */
const COMMAND = process.platform === 'win32' ? 'cmdc' : 'cmd'

/** An npm-style Windows shim, as `npm install -g command-code` writes it. */
const REAL_SHIM = [
  '@ECHO off',
  'GOTO start',
  ':find_dp0',
  'SET dp0=%~dp0',
  'EXIT /b',
  ':start',
  'SETLOCAL',
  'CALL :find_dp0',
  '',
  'IF EXIST "%dp0%\\node.exe" (',
  '  SET "_prog=%dp0%\\node.exe"',
  ') ELSE (',
  '  SET "_prog=node"',
  '  SET PATHEXT=%PATHEXT:;.JS;=;%',
  ')',
  '',
  'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\command-code\\dist\\index.mjs" %*',
].join('\r\n')

/** A trimmed copy of the real `--list-models` listing. */
const REAL_LISTING = [
  'Available models  ·  70 models',
  '',
  'Open Source',
  '',
  'deepseek/deepseek-v4-pro               hybrid-attention long-context reasoning',
  'deepseek/deepseek-v4.1-flash           V4.1 hybrid-attention reasoning with vision',
  'zai-org/glm-5.3                        frontier coding with emergent cyber capabilities',
  '',
  'Anthropic',
  '',
  'claude-sonnet-5                        best combo of speed & intelligence (recommended)',
  '',
  'Pass the full id, or just the short name after the last "/":',
  'cmdc --model moonshotai/kimi-k2.5',
  'cmdc --model kimi-k2.5',
  '',
  'Docs:  https://commandcode.ai/docs/reference/cli/models',
].join('\n')

function result(overrides: Partial<CommandCodeProcessResult> = {}): CommandCodeProcessResult {
  return { exitCode: 0, signal: null, stdout: '', stderr: '', ...overrides }
}

/** A runner that answers each helper invocation from a fixed table. */
function runnerFor(
  table: Readonly<Record<string, () => CommandCodeProcessResult>>,
): CommandCodeRunner {
  return async (args) => {
    const answer = table[args[0] ?? '']
    if (answer === undefined) throw new Error(`unexpected helper ${args.join(' ')}`)
    return answer()
  }
}

describe('resolveCommandCodeInvocation', () => {
  it('runs the executable from PATH outside Windows', () => {
    const invocation = resolveCommandCodeInvocation('linux', {
      pathEntries: ['/usr/local/bin'],
      exists: () => false,
      readText: () => '',
    })
    expect(invocation).toEqual({ program: 'cmd', prefix: [], source: 'path' })
  })

  it('translates the Windows npm shim to its JavaScript entry', () => {
    const entry = 'C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\command-code\\dist\\index.mjs'
    const invocation = resolveCommandCodeInvocation('win32', {
      pathEntries: ['C:\\Windows', 'C:\\Users\\me\\AppData\\Roaming\\npm'],
      exists: path => path.startsWith('C:\\Users\\me'),
      readText: () => REAL_SHIM,
    })
    expect(invocation.source).toBe('windows-shim')
    expect(invocation.program).toBe(process.execPath)
    expect(invocation.prefix).toEqual([entry])
  })

  it('fails loud when the Windows CLI is not installed', () => {
    expect(() => resolveCommandCodeInvocation('win32', {
      pathEntries: ['C:\\Windows'],
      exists: () => false,
      readText: () => '',
    })).toThrow(/cmdc is not on PATH/u)
  })

  it('fails loud when the shim names no JavaScript entry', () => {
    expect(() => resolveCommandCodeInvocation('win32', {
      pathEntries: ['C:\\npm'],
      exists: () => true,
      readText: () => '@ECHO off\r\n',
    })).toThrow(/does not name a JavaScript entry/u)
  })
})

describe('windowsShimEntry', () => {
  it('expands the shim directory placeholder', () => {
    expect(windowsShimEntry(REAL_SHIM, 'C:\\npm'))
      .toBe('C:\\npm\\node_modules\\command-code\\dist\\index.mjs')
  })

  it('reports nothing for a script that names no entry', () => {
    expect(windowsShimEntry('echo hi', 'C:\\npm')).toBeUndefined()
  })
})

describe('probeCommandCode', () => {
  it('reports an installed, authenticated CLI', async () => {
    const health = await probeCommandCode(
      runnerFor({
        '--version': () => result({ stdout: '1.54.0\n' }),
        status: () => result({ stdout: '√ Authenticated as someone\n  Provider: Command Code\n' }),
      }),
      new AbortController().signal,
    )
    expect(health).toEqual({
      command: COMMAND,
      installed: true,
      version: '1.54.0',
      authenticated: true,
    })
  })

  it('reports a missing CLI with login guidance and no fallback', async () => {
    const health = await probeCommandCode(
      runnerFor({}),
      new AbortController().signal,
    )
    expect(health.installed).toBe(false)
    expect(health.authenticated).toBe(false)
    expect(health.detail).toContain('login')
  })

  it('reports an unauthenticated CLI from the documented auth exit code', async () => {
    const health = await probeCommandCode(
      runnerFor({
        '--version': () => result({ stdout: '1.54.0\n' }),
        status: () => result({ exitCode: 3, stdout: 'Not authenticated\n' }),
      }),
      new AbortController().signal,
    )
    expect(health.installed).toBe(true)
    expect(health.authenticated).toBe(false)
    expect(health.detail).toContain(`${COMMAND} login`)
  })

  it('reports a version probe that failed rather than claiming health', async () => {
    const health = await probeCommandCode(
      runnerFor({ '--version': () => result({ exitCode: 1 }) }),
      new AbortController().signal,
    )
    expect(health.installed).toBe(false)
  })
})

describe('parseModelCatalog', () => {
  it('reads ids and descriptions from the real listing format', () => {
    const models = parseModelCatalog(REAL_LISTING)
    expect(models.map(model => model.id)).toEqual([
      'deepseek/deepseek-v4-pro',
      'deepseek/deepseek-v4.1-flash',
      'zai-org/glm-5.3',
      'claude-sonnet-5',
    ])
    expect(models[1]?.description).toBe('V4.1 hybrid-attention reasoning with vision')
  })

  it('skips headings, the usage footer, and prose', () => {
    const ids = parseModelCatalog(REAL_LISTING).map(model => model.id)
    expect(ids).not.toContain('Available')
    expect(ids).not.toContain('Docs:')
    expect(ids).not.toContain('cmdc')
  })

  it('returns nothing for a reformatted listing, so a manual id is required', () => {
    expect(parseModelCatalog('No models available right now.')).toEqual([])
  })
})

describe('readCommandCodeCatalog', () => {
  it('returns the parsed catalog', async () => {
    const catalog = await readCommandCodeCatalog(
      runnerFor({ '--list-models': () => result({ stdout: REAL_LISTING }) }),
      new AbortController().signal,
    )
    expect(catalog.models).toHaveLength(4)
    expect(catalog.detail).toBeUndefined()
  })

  it('explains itself instead of failing when the catalog cannot be read', async () => {
    const catalog = await readCommandCodeCatalog(
      runnerFor({ '--list-models': () => result({ exitCode: 1 }) }),
      new AbortController().signal,
    )
    expect(catalog.models).toEqual([])
    expect(catalog.detail).toMatch(/manually/u)
  })
})
