/**
 * Tests for the event-relation collector's demand-driven call-site indexing:
 * the single-file fast path and the global fallback must recover the same
 * helper-parameter event names, including shapes that defeat the locality
 * proof (alias escapes and global script files).
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { collectPackageSources, EventRelationCollector } from './gen-doc-graphs.ts'
import { TypeScriptProject } from './ts-project.ts'

const REJECTED_HELPERS = [
  { pkg: 'public-method', declaration: 'public fanOut(...args: [string])', argument: "'negative/event'" },
  { pkg: 'implicit-public-method', declaration: 'fanOut(...args: [string])', argument: "'negative/event'" },
  { pkg: 'protected-method', declaration: 'protected fanOut(...args: [string])', argument: "'negative/event'" },
  { pkg: 'generic-method', declaration: 'private fanOut<Event extends string>(...args: [Event])', argument: "'negative/event'" },
  { pkg: 'widened-name', declaration: 'private fanOut(...args: [string, string])', argument: "name, 'negative/event'", setup: "const name: string = 'negative/event'" },
  { pkg: 'unresolved-name', declaration: "private fanOut(...args: ['negative/event'])", argument: 'missingName' },
  { pkg: 'widened-spread', declaration: 'private fanOut(...args: [string, string])', argument: "...[name, 'negative/event']", setup: "const name: string = 'negative/event'" },
  { pkg: 'widened-tuple', declaration: 'private fanOut(args: [string, string])', argument: "[name, 'negative/event']", setup: "const name: string = 'negative/event'" },
  { pkg: 'unresolved-tuple', declaration: "private fanOut(args: ['negative/event'])", argument: '[missingName]' },
  { pkg: 'widened-rest', declaration: 'private fanOut(...args: string[])', argument: "'negative/event'" },
  { pkg: 'wrong-receiver', declaration: 'private fanOut(...args: [string])', argument: "'negative/event'", receiver: '{ dispatch(type: string, args: unknown[]): void }' },
] as const

const FIXTURE: Record<string, string> = {
  'tsconfig.host.json': JSON.stringify({
    compilerOptions: {
      target: 'es2022',
      module: 'esnext',
      moduleResolution: 'bundler',
      allowImportingTsExtensions: true,
      noEmit: true,
      skipLibCheck: true,
      types: [],
    },
    include: ['vendor/**/*.ts', 'packages/**/*.ts'],
  }),
  'vendor/cordis/src/context.ts': 'export class Context { private brand!: void }\n',
  'vendor/cordis/src/events.ts': [
    'export class EventsService {',
    '  dispatch(type: string, args: unknown[]): unknown[] { return [type, args] }',
    '}',
    '',
  ].join('\n'),
  'packages/core/agent/src/dispatch.ts':
    'export interface AgentEventDispatch { emit(...args: unknown[]): void }\n',
  // fireLocal: every same-file reference is a direct callee, so the locality
  // proof holds and only this file is indexed. fireAliased: the exported
  // const is a value-position reference, so the proof fails and the global
  // fallback must find the cross-file call in pkgb.
  'packages/fix/pkga/src/index.ts': [
    "import { EventsService } from '../../../../vendor/cordis/src/events.ts'",
    'declare const events: EventsService',
    "function fireLocal(args: [string]): void { void events.dispatch('emit', args) }",
    "fireLocal(['pkga/local-event'])",
    "function fireAliased(args: [string]): void { void events.dispatch('emit', args) }",
    'export const aliased = fireAliased',
    '',
  ].join('\n'),
  'packages/fix/pkgb/src/index.ts': [
    "import { aliased } from '../../pkga/src/index.ts'",
    "aliased(['pkgb/aliased-event'])",
    '',
  ].join('\n'),
  // Global script files (no import/export): scriptFire is program-visible, so
  // the cross-file call in caller.ts leaves no same-file reference. Only the
  // module-ness premise check routes this helper to the global index; without
  // it the proof would pass and the event would silently drop.
  'packages/fix/pkgc/src/globals.ts':
    "declare var gEvents: import('../../../../vendor/cordis/src/events.ts').EventsService\n",
  'packages/fix/pkgc/src/helper.ts':
    "function scriptFire(args: [string]): void { void gEvents.dispatch('emit', args) }\n",
  'packages/fix/pkgc/src/caller.ts': "scriptFire(['pkgc/script-event'])\n",
  'packages/fix/private-rest/src/index.ts': [
    "import { EventsService } from '../../../../vendor/cordis/src/events.ts'",
    'export abstract class Provider {',
    '  constructor(private readonly ctx: { events: EventsService }) {}',
    "  protected notifyUpdated(ref: string): void { this.fanOut('credentials/reference-updated', ref) }",
    "  protected notifyRecordUpdated(key: string): void { this.fanOut('credentials/record-updated', key) }",
    "  protected notifySourceFailure(): void { this.fanOut('credentials/source-failed') }",
    "  protected notifySpread(): void { const args: ['private/spread'] = ['private/spread']; this.fanOut(...args) }",
    "  protected notifyTuple(): void { this.fireTuple(['private/array']) }",
    "  private fireTuple(args: ['private/array' | 'private/array-dead']): void { void this.ctx.events.dispatch('emit', args) }",
    "  private fanOut(...args: ['credentials/reference-updated' | 'credentials/record-updated' | 'credentials/dead', string] | ['credentials/source-failed' | 'private/spread']): void {",
    "    void this.ctx.events.dispatch('emit', [...args])",
    '    this.fanOut(...args)',
    '  }',
    '}',
    '',
  ].join('\n'),
  'packages/fix/exported-helper/src/index.ts': [
    "import { EventsService } from '../../../../vendor/cordis/src/events.ts'",
    'declare const events: EventsService',
    "export function fanOut(...args: [string]): void { void events.dispatch('emit', args) }",
    "fanOut('negative/event')",
    '',
  ].join('\n'),
  'packages/fix/generic-function/src/index.ts': [
    "import { EventsService } from '../../../../vendor/cordis/src/events.ts'",
    'declare const events: EventsService',
    "function fanOut<Event extends string>(args: [Event]): void { void events.dispatch('emit', args) }",
    "fanOut(['function/generic-event'])",
    '',
  ].join('\n'),
  ...Object.fromEntries(REJECTED_HELPERS.map(({ pkg, declaration, argument, ...options }) => [
    `packages/fix/${pkg}/src/index.ts`,
    [
      "import { EventsService } from '../../../../vendor/cordis/src/events.ts'",
      `declare const events: ${'receiver' in options ? options.receiver : 'EventsService'}`,
      'export class Provider {',
      `  notify(): void { ${'setup' in options ? options.setup + '; ' : ''}this.fanOut(${argument}) }`,
      `  ${declaration}: void { void events.dispatch('emit', args) }`,
      '}',
      '',
    ].join('\n'),
  ])),
}

const root = mkdtempSync(join(tmpdir(), 'gen-doc-graphs-'))
for (const [rel, content] of Object.entries(FIXTURE)) {
  mkdirSync(dirname(join(root, rel)), { recursive: true })
  writeFileSync(join(root, rel), content)
}
const project = new TypeScriptProject(root)
const sources = collectPackageSources(project)

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

function dispatchersOf(pkgs: readonly string[], event: string): string[] {
  const subset = sources.filter(source => pkgs.includes(source.pkg))
  const relations = new EventRelationCollector(project, subset).collect()
  return [...(relations.get(event)?.dispatchers.keys() ?? [])]
}

describe('event relation call-site indexing', () => {
  it('recovers a proven-local helper through the single-file fast path', () => {
    expect(dispatchersOf(['pkga', 'pkgb'], 'pkga/local-event')).toEqual(['pkga'])
  })

  it('recovers an alias-escaped helper through the global fallback', () => {
    expect(dispatchersOf(['pkga', 'pkgb'], 'pkgb/aliased-event')).toEqual(['pkga'])
  })

  it.each(['credentials/reference-updated', 'credentials/record-updated', 'credentials/source-failed'])(
    'recovers %s from actual private rest-tuple calls despite recursive forwarding',
    (event) => {
      expect(dispatchersOf(['private-rest'], event)).toEqual(['private-rest'])
    },
  )

  it('recovers a literal event from a const tuple spread into the private rest helper', () => {
    expect(dispatchersOf(['private-rest'], 'private/spread')).toEqual(['private-rest'])
  })

  it('recovers the actual tuple argument of a private class helper', () => {
    expect(dispatchersOf(['private-rest'], 'private/array')).toEqual(['private-rest'])
    expect(dispatchersOf(['private-rest'], 'private/array-dead')).toEqual([])
  })

  it('does not count a never-passed literal in the private rest-tuple union', () => {
    expect(dispatchersOf(['private-rest'], 'credentials/dead')).toEqual([])
  })

  it('retains finite call-site inference for a generic local function', () => {
    expect(dispatchersOf(['generic-function'], 'function/generic-event')).toEqual(['generic-function'])
  })

  it.each([...REJECTED_HELPERS.map(({ pkg }) => pkg), 'exported-helper'])(
    'does not infer a producer through %s',
    (pkg) => {
      expect(dispatchersOf([pkg], 'negative/event')).toEqual([])
    },
  )

  it('rejects the locality proof for global script files', () => {
    // pkgc alone: the script helper is the first demand, so a wrongly passing
    // proof would index helper.ts only and lose the caller.ts call site.
    expect(dispatchersOf(['pkgc'], 'pkgc/script-event')).toEqual(['pkgc'])
  })
})
