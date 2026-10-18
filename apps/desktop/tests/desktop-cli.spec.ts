/** Desktop CLI package-manager options keep payload overrides separate from physical launchers. */
import { delimiter, dirname, join, resolve } from 'node:path'
import { expect, it } from 'vitest'
import { resolveDesktopCliOptions } from '../../desktop-host/src/cli-options.ts'

it.each(['system-bin', undefined])('uses shared bundled pnpm when PATH is %s', (path) => {
  const runtime = join('Application 中文 with spaces', 'resources', 'app.asar', 'dsh')
  const support = join('Application 中文 with spaces', 'resources', 'runtime')
  expect(resolveDesktopCliOptions(runtime, { PATH: path })).toEqual({
    manageDesktopProfile: true,
    packageManager: {
      command: process.execPath,
      args: ['--expose-internals', join(support, 'primary-runtime', 'dependencies', 'pnpm', 'bin', 'pnpm.mjs')],
      env: {
        ELECTRON_RUN_AS_NODE: '1',
        DSH_DESKTOP_NODE_EXECUTABLE: process.execPath,
        PATH: `${join(support, 'bin')}${delimiter}${path ?? ''}`,
      },
    },
  })
})

it.each([resolve('Payloads 中文/custom-runtime'), join('relative-payloads', 'renamed-runtime')])(
  'uses the exact primary-runtime override %s with its sibling Node launchers', (override) => {
    const runtime = join('Application resources', 'app.asar', 'dsh')
    const options = resolveDesktopCliOptions(runtime, { DSH_DESKTOP_PRIMARY_RUNTIME_DIR: override, PATH: 'system-bin' })
    expect(options.packageManager?.args).toEqual(['--expose-internals',
      join(resolve(override), 'dependencies', 'pnpm', 'bin', 'pnpm.mjs')])
    expect(options.packageManager?.env?.PATH).toBe(`${join(dirname(resolve(override)), 'bin')}${delimiter}system-bin`)
  },
)

it('resolves prepared runtime resources without an ASAR archive', () => {
  const options = resolveDesktopCliOptions(join('prepared', 'dsh'), {})
  expect(options.packageManager?.args).toEqual(['--expose-internals',
    join('prepared', 'runtime', 'primary-runtime', 'dependencies', 'pnpm', 'bin', 'pnpm.mjs')])
})

it('uses the selected copied generation runtime outside its app/dsh tree', () => {
  const generation = resolve('Generation 中文 with spaces')
  const support = join(generation, 'runtime')
  const primary = join(support, 'renamed-payload')
  const options = resolveDesktopCliOptions(join(generation, 'app', 'dsh'), { DSH_DESKTOP_PRIMARY_RUNTIME_DIR: primary })
  expect(options.packageManager?.args).toEqual(['--expose-internals',
    join(primary, 'dependencies', 'pnpm', 'bin', 'pnpm.mjs')])
  expect(options.packageManager?.env?.PATH).toBe(`${join(support, 'bin')}${delimiter}`)
})

it('rejects an empty payload override instead of selecting the launch directory', () => {
  expect(() => resolveDesktopCliOptions(join('prepared', 'dsh'), { DSH_DESKTOP_PRIMARY_RUNTIME_DIR: '' }))
    .toThrow('DSH_DESKTOP_PRIMARY_RUNTIME_DIR must not be empty')
})
