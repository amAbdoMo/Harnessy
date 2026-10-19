/** Profile patch edits preserve user-authored syntax and are idempotent. */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { expect, it, onTestFinished } from 'vitest'
import { applyEntryPatches } from '@deepseek-ai/cordis-plugin-include'
import type { EntryOptions } from '@deepseek-ai/cordis-plugin-loader'
import { composeEntries, initProfile, loadOptionalPatches, readProfilePatches, type ProfileContext } from '@deepseek-ai/dsh-app-boot'
import { writePluginEnabled } from '../src/patch.ts'

const TOOL = { id: 'tool', name: 'package' }

/** Create real profile and selected bundle files; an omitted patch remains absent. */
async function fixture(text?: string, rows: EntryOptions[] = []): Promise<ProfileContext> {
  const home = await mkdtemp(join(tmpdir(), 'manager-patch-'))
  onTestFinished(() => rm(home, { recursive: true, force: true }))
  const dir = join(home, 'profile')
  const installAnchor = join(home, 'package.json')
  await writeFile(installAnchor, '{"name":"installation","dependencies":{}}')
  initProfile(dir, ['bundle'])
  const bundle = join(dir, 'node_modules', 'bundle')
  await mkdir(bundle, { recursive: true })
  await writeFile(join(bundle, 'package.json'), JSON.stringify({ name: 'bundle', version: '1.0.0', dsh: { bundle: { patch: './cordis.patch.yml' } } }))
  await writeFile(join(bundle, 'cordis.patch.yml'), JSON.stringify([{ insert: rows }]))
  const patchPath = join(dir, 'cordis.patch.yml')
  await (text === undefined ? rm(patchPath) : writeFile(patchPath, text))
  return { name: 'test', dir, patchPath, installAnchor, cwd: home, home, startedBundles: ['bundle'], overlays: [], telemetryDisabledEnv: undefined }
}

it('preserves comments, expressions, unrelated configuration and the last override', async () => {
  const profile = await fixture('# personal configuration\n- id: tool\n  config:\n    value: !!js process.platform\n- id: tool\n  disabled: false # availability\n')
  expect(await writePluginEnabled(profile, 'tool', 'package', false)).toBe(true)
  const text = await readFile(profile.patchPath, 'utf8')
  expect(text).toContain('# personal configuration')
  expect(text).toContain('!!js process.platform')
  expect(text).toContain('# availability')
  expect(loadOptionalPatches('test', profile.patchPath)).toEqual([
    { id: 'tool', config: { value: { __jsExpr: 'process.platform' } } }, { id: 'tool', disabled: true },
  ])
  expect(await writePluginEnabled(profile, 'tool', 'package', false)).toBe(false)
  expect(await readFile(profile.patchPath, 'utf8')).toBe(text)
  expect(await writePluginEnabled(profile, 'tool', 'package', true)).toBe(true)
})

it('creates a missing patch file and appends only necessary switches after insertions', async () => {
  const profile = await fixture()
  expect(await writePluginEnabled(profile, 'tool', 'package', false)).toBe(true)
  expect(loadOptionalPatches('test', profile.patchPath)).toEqual([{ id: 'tool', disabled: true }])
  const insertion = '- insert:\n    - id: tool\n      name: package\n'
  await writeFile(profile.patchPath, insertion)
  expect(await writePluginEnabled(profile, 'tool', 'package', true)).toBe(false)
  expect(await readFile(profile.patchPath, 'utf8')).toBe(insertion)
  expect(await writePluginEnabled(profile, 'tool', 'package', false)).toBe(true)
  expect(loadOptionalPatches('test', profile.patchPath)).toEqual([
    { insert: [{ id: 'tool', name: 'package' }] }, { id: 'tool', disabled: true },
  ])
})

it.each(['- id: [broken', 'mapping: true\n'])('refuses malformed documents without overwriting %s', async (text) => {
  const profile = await fixture(text)
  await expect(writePluginEnabled(profile, 'tool', 'package', true)).rejects.toThrow()
  expect(await readFile(profile.patchPath, 'utf8')).toBe(text)
})

it('retains name-asserting overrides and appends an unambiguous switch', async () => {
  const profile = await fixture('- id: tool\n  name: another-package\n  disabled: false\n')
  await writePluginEnabled(profile, 'tool', 'package', false)
  expect(loadOptionalPatches('test', profile.patchPath)).toEqual([
    { id: 'tool', name: 'another-package', disabled: false }, { id: 'tool', disabled: true },
  ])
  expect(await writePluginEnabled(profile, 'tool', 'package', false)).toBe(false)
})

it('reports read failures without replacing a directory with configuration', async () => {
  const profile = await fixture()
  await mkdir(profile.patchPath)
  await expect(writePluginEnabled(profile, 'tool', 'package', true)).rejects.toThrow()
})

it('updates the last matching named override and leaves mismatched names untouched', async () => {
  const profile = await fixture('- id: tool\n  disabled: true\n- id: tool\n  name: package\n  config:\n    value: !!js process.platform\n  disabled: true # availability\n- id: tool\n  name: another-package\n  disabled: true\n')
  expect(await writePluginEnabled(profile, 'tool', 'package', true)).toBe(true)
  const text = await readFile(profile.patchPath, 'utf8')
  expect(text).toContain('!!js process.platform')
  expect(text).toContain('# availability')
  const patches = loadOptionalPatches('test', profile.patchPath)
  expect(patches).toEqual([
    { id: 'tool', disabled: true },
    { id: 'tool', name: 'package', config: { value: { __jsExpr: 'process.platform' } }, disabled: false },
    { id: 'tool', name: 'another-package', disabled: true },
  ])
  expect(applyEntryPatches([{ id: 'tool', name: 'package' }], patches, () => {}))
    .toMatchObject([{ id: 'tool', name: 'package', disabled: false }])
  expect(await writePluginEnabled(profile, 'tool', 'package', true)).toBe(false)
  expect(await readFile(profile.patchPath, 'utf8')).toBe(text)
  expect(await writePluginEnabled(profile, 'tool', 'package', false)).toBe(true)
  expect(loadOptionalPatches('test', profile.patchPath)).toHaveLength(3)
})

it('removes or omits a plain switch that restates the bundle layers', async () => {
  const profile = await fixture('# personal configuration\n- id: other\n  disabled: true\n- id: tool\n  disabled: true\n', [TOOL])
  expect(await writePluginEnabled(profile, 'tool', 'package', true)).toBe(true)
  const expected = '# personal configuration\n- id: other\n  disabled: true\n'
  expect(await readFile(profile.patchPath, 'utf8')).toBe(expected)
  expect(await writePluginEnabled(profile, 'tool', 'package', true)).toBe(false)
  expect(await readFile(profile.patchPath, 'utf8')).toBe(expected)
  expect(await writePluginEnabled(profile, 'tool', 'package', false)).toBe(true)
  expect(loadOptionalPatches('test', profile.patchPath)).toEqual([{ id: 'other', disabled: true }, { id: 'tool', disabled: true }])
})

it('does not create a missing patch when the bundle already implies the requested state', async () => {
  const profile = await fixture(undefined, [TOOL])
  expect(await writePluginEnabled(profile, 'tool', 'package', true)).toBe(false)
  await expect(readFile(profile.patchPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
})

it.each([
  ['configuration', '  config: { value: 1 }\n', { config: { value: 1 } }],
  ['name assertion', '  name: package\n', { name: 'package' }],
])('keeps a switch that carries %s', async (_, setting, expected) => {
  const profile = await fixture(`- id: tool\n${setting}  disabled: true\n`, [TOOL])
  expect(await writePluginEnabled(profile, 'tool', 'package', true)).toBe(true)
  expect(loadOptionalPatches('test', profile.patchPath)).toEqual([{ id: 'tool', ...expected, disabled: false }])
})

it('keeps a necessary switch and prunes it when returning to a disabled bundle default', async () => {
  const profile = await fixture('- id: tool\n  disabled: true\n', [{ ...TOOL, disabled: true }])
  expect(await writePluginEnabled(profile, 'tool', 'package', true)).toBe(true)
  expect(loadOptionalPatches('test', profile.patchPath)).toEqual([{ id: 'tool', disabled: false }])
  expect(await writePluginEnabled(profile, 'tool', 'package', false)).toBe(true)
  expect(loadOptionalPatches('test', profile.patchPath)).toEqual([])
  expect(composeEntries([readProfilePatches('test', profile)])).toMatchObject([{ id: 'tool', disabled: true }])
})

it('compares remaining profile patches instead of just the bundle default', async () => {
  const profile = await fixture('- id: tool\n  disabled: true\n- id: tool\n  disabled: true\n', [TOOL])
  expect(await writePluginEnabled(profile, 'tool', 'package', true)).toBe(true)
  expect(loadOptionalPatches('test', profile.patchPath)).toEqual([{ id: 'tool', disabled: true }, { id: 'tool', disabled: false }])
  expect(await writePluginEnabled(profile, 'tool', 'package', false)).toBe(true)
  expect(loadOptionalPatches('test', profile.patchPath)).toEqual([{ id: 'tool', disabled: true }])
})

it.each([
  ['group', true, []],
  ['opaque config', false, [{ id: 'tool', disabled: false }]],
])('compares only patch-addressable children of a %s', async (_, group, expected) => {
  const profile = await fixture('- id: tool\n  disabled: true\n', [{ id: 'parent', name: 'parent', group, config: [TOOL] }])
  expect(await writePluginEnabled(profile, 'tool', 'package', true)).toBe(true)
  expect(loadOptionalPatches('test', profile.patchPath)).toEqual(expected)
})

it.each([true, false])('keeps a literal override over a bundle expression when enabling is %s', async (enabled) => {
  const profile = await fixture('- id: tool\n  disabled: true\n')
  await writeFile(join(profile.dir, 'node_modules', 'bundle', 'cordis.patch.yml'), `- insert:\n    - id: tool\n      name: package\n      disabled: !!js ${String(!enabled)}\n`)
  expect(await writePluginEnabled(profile, 'tool', 'package', enabled)).toBe(enabled)
  expect(loadOptionalPatches('test', profile.patchPath)).toEqual([{ id: 'tool', disabled: !enabled }])
})

it('re-reads the current bundle file rather than retaining startup defaults', async () => {
  const profile = await fixture('[]\n', [TOOL])
  expect(await writePluginEnabled(profile, 'tool', 'package', true)).toBe(false)
  await writeFile(join(profile.dir, 'node_modules', 'bundle', 'cordis.patch.yml'), JSON.stringify([{ insert: [{ ...TOOL, disabled: true }] }]))
  expect(await writePluginEnabled(profile, 'tool', 'package', true)).toBe(true)
  expect(loadOptionalPatches('test', profile.patchPath)).toEqual([{ id: 'tool', disabled: false }])
})

it.each(['home', 'invocation'] as const)('excludes the %s overlay from what the profile stores', async (layer) => {
  const profile = await fixture('- id: tool\n  disabled: true\n', [TOOL])
  if (layer === 'home') await writeFile(join(profile.home, 'cordis.patch.yml'), '- id: tool\n  disabled: true\n')
  const context = layer === 'invocation' ? { ...profile, overlays: [{ id: 'tool', disabled: true }] } : profile
  expect(await writePluginEnabled(context, 'tool', 'package', true)).toBe(true)
  expect(loadOptionalPatches('test', profile.patchPath)).toEqual([])
  expect(composeEntries([readProfilePatches('test', context)])).toMatchObject([{ id: 'tool', disabled: true }])
  expect(await writePluginEnabled(context, 'tool', 'package', true)).toBe(false)
  expect(await writePluginEnabled(context, 'tool', 'package', false)).toBe(true)
  expect(loadOptionalPatches('test', profile.patchPath)).toEqual([{ id: 'tool', disabled: true }])
})

it.each([
  ['before following comments', '# header\n- id: tool\n  disabled: false\n# other\n- id: other\n  disabled: true\n', '# header\n# other\n- id: other\n  disabled: true\n'],
  ['before the following item', '# header\n- id: tool\n  disabled: true\n- id: other\n  disabled: true\n', '# header\n- id: other\n  disabled: true\n'],
  ['above the empty sequence', '# header\n- id: tool\n  disabled: true\n', '# header\n[]\n'],
  ['after remaining items', '- id: other\n  disabled: true\n# about tool\n- id: tool\n  disabled: true\n', '- id: other\n  disabled: true\n\n# about tool\n'],
  ['before the trailing comment', '- id: other\n  disabled: true\n# about tool\n- id: tool\n  disabled: true\n# tail\n', '- id: other\n  disabled: true\n\n# about tool\n# tail\n'],
  ['below the empty sequence', '- id: tool\n  disabled: true # removed\n# tail\n', '[]\n\n# tail\n'],
  ['around the empty sequence', '# header\n- id: tool\n  disabled: true\n# tail\n', '# header\n[]\n\n# tail\n'],
])('keeps comments %s when pruning a switch', async (_, text, expected) => {
  const profile = await fixture(text, [TOOL])
  expect(await writePluginEnabled(profile, 'tool', 'package', true)).toBe(true)
  expect(await readFile(profile.patchPath, 'utf8')).toBe(expected)
  expect(loadOptionalPatches('test', profile.patchPath)).toEqual(text.includes('id: other') ? [{ id: 'other', disabled: true }] : [])
})

it.each([
  ['a value', '- id: &plugin tool\n  disabled: true\n- id: other\n  config: { target: *plugin }\n', { target: 'tool' }, '&plugin'],
  ['the entry', '- &plugin { id: tool, disabled: true }\n- id: other\n  config: { target: *plugin }\n', { target: { id: 'tool', disabled: false } }, '&plugin'],
  ['a key', '- id: tool\n  &key disabled: true\n- id: other\n  config: { *key : 1 }\n', { disabled: 1 }, '&key'],
  ['disabled', '- id: tool\n  disabled: &flag true\n- id: other\n  config: { flag: *flag }\n', { flag: false }, '&flag'],
])('keeps a switch whose anchor on %s other entries reference', async (_, text, config, anchor) => {
  const profile = await fixture(text, [TOOL])
  expect(await writePluginEnabled(profile, 'tool', 'package', true)).toBe(true)
  expect(loadOptionalPatches('test', profile.patchPath)).toEqual([{ id: 'tool', disabled: false }, { id: 'other', config }])
  expect(await readFile(profile.patchPath, 'utf8')).toContain(anchor)
})

it('keeps a switch whose value is an alias', async () => {
  const profile = await fixture('- id: other\n  config: { flag: &flag true }\n- id: tool\n  disabled: *flag\n', [TOOL])
  expect(await writePluginEnabled(profile, 'tool', 'package', true)).toBe(true)
  expect(loadOptionalPatches('test', profile.patchPath)).toEqual([{ id: 'other', config: { flag: true } }, { id: 'tool', disabled: false }])
})
