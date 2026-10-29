/** Keyless preview handoff results through the actual CLI and shipped ACP profile. */
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join, resolve } from 'node:path'
import { expect, it } from 'vitest'
import {
  runScenario, normalizeSessionSnapshots, normalizeStdout, normalizedToolSchemas, normalizedSystemPrompts,
  redactSessionSnapshotIds, scrubSessionSnapshot, tokenizeSessionFixtureCwd, sessionFixtureName,
  sessionHeaderVersion, stabilizeFixtureMessageIds, formatSystemPromptSnapshot, formatToolSchemasSnapshot,
  type RunOptions,
} from '@deepseek-ai/dsh-session-snapshot'
import { parseSessionLog } from '@deepseek-ai/dsh-llm-replay'

const dir = fileURLToPath(new URL('.', import.meta.url))
const root = resolve(dir, '../../..')
const fixtureFile = join(dir, 'session.v4.jsonl')
const mode = process.env.DSH_SNAPSHOT ?? 'replay'
assert.ok(['record', 'refresh', 'replay'].includes(mode), 'Unknown snapshot mode')
const recording = mode === 'record'
const updating = mode !== 'replay'

it('desktop preview observes takeover and resumes on the same tab without saved-site grants', async () => {
  const prompts = recording ? ['Inspect the browser tab during human takeover, verify actions are refused, then resume and read the same tab.']
    : parseSessionLog(await readFile(fixtureFile, 'utf8'))
      .filter(event => event.type === 'user/message' && event.data.source?.kind === 'user')
      .map(event => {
        assert.equal(event.type, 'user/message')
        const block = event.data.content[0]
        assert.ok(block && block.type === 'text')
        return block.text
      })
  expect(prompts).toHaveLength(1)
  const driver = browserPreviewDriver()
  const result = await runScenario({ steps: [
    { op: 'initialize' }, { op: 'newSession' }, ...prompts.map(text => ({ op: 'prompt', text } as const)),
  ] }, {
    agent: { binScript: join(root, 'apps/cli/src/bin.ts'), profile: 'acp',
      configPath: join(dir, 'cordis.yml'), tsconfigPath: join(root, 'tsconfig.json') },
    mode: recording ? 'record' : 'replay', fixtureFile, privateDriver: driver,
    env: { DEEPSEEK_API_KEY: undefined, OPENAI_API_KEY: undefined, ANTHROPIC_API_KEY: undefined },
  })
  expect(driver.operations).toBe(4)
  expect(result.rawStdout).not.toContain('session/request_permission')
  expect(result.sessionLogs).toHaveLength(1)
  const log = result.sessionLogs[0]
  assert.ok(log)
  expect(log.content).toContain('Observed during takeover')
  expect(log.content).toContain('A human controls this browser tab')
  expect(log.content).not.toContain('approval/asked')
  expect(log.content).not.toContain('approval/decided')
  const ctx = { cwd: result.cwd, cwdAliases: result.cwdAliases, sessionIds: [log.id] }
  const sessions = normalizeSessionSnapshots([log.content], ctx, { nativeWriterOutput: true })
  const systemPrompts = normalizedSystemPrompts(log.content, ctx)
  const toolSchemas = normalizedToolSchemas(log.content, ctx)
  assert.ok(systemPrompts[0] !== undefined && toolSchemas[0] !== undefined)
  const sidecars = {
    'stdout.expected.jsonl': normalizeStdout(result.rawStdout, ctx),
    'system-prompt.expected.md': formatSystemPromptSnapshot(systemPrompts[0], systemPrompts.slice(1)),
    'tool-schemas.expected.json': formatToolSchemasSnapshot(toolSchemas[0], toolSchemas.slice(1)),
  }
  if (updating) {
    const output = redactSessionSnapshotIds(stabilizeFixtureMessageIds([
      scrubSessionSnapshot(tokenizeSessionFixtureCwd(log.content)),
    ], []))[0]
    assert.ok(output)
    await writeFile(join(dir, sessionFixtureName(0, sessionHeaderVersion(log.content, 'browser preview CLI session'))), output)
    for (const [name, content] of Object.entries(sidecars)) await writeFile(join(dir, name), content)
  } else {
    const fixture = await readFile(fixtureFile, 'utf8')
    expect(sessions).toEqual(normalizeSessionSnapshots([fixture], { cwd: '{{cwd}}', sessionIds: [] }, { nativeWriterOutput: true }))
    for (const [name, content] of Object.entries(sidecars)) expect(content).toBe(await readFile(join(dir, name), 'utf8'))
  }
})

function browserPreviewDriver(): NonNullable<RunOptions['privateDriver']> & { operations: number } {
  const driver = {
    operations: 0,
    afterStep: () => Promise.resolve(),
    async receive(input: unknown, send: (message: object) => Promise<void>): Promise<void> {
      assert.ok(typeof input === 'object' && input !== null && 'type' in input && input.type === 'browser-preview'
        && 'requestId' in input && typeof input.requestId === 'string' && 'sessionId' in input && typeof input.sessionId === 'string'
        && 'operation' in input && typeof input.operation === 'object' && input.operation !== null && 'kind' in input.operation)
      const operation = input.operation
      const index = driver.operations++
      const status = { tabId: 'fixture-tab', sessionId: input.sessionId, humanControl: index < 3,
        generation: index < 3 ? 1 : 2, url: 'https://browser.example/', title: 'Browser fixture', loading: false }
      if (index === 0) {
        assert.equal(operation.kind, 'status')
        await send({ type: 'browser-preview-result', requestId: input.requestId, ok: true, result: { tabs: [status] } })
      } else if (index === 1) {
        assert.equal(operation.kind, 'evaluate')
        await send({ type: 'browser-preview-result', requestId: input.requestId, ok: false,
          error: 'A human controls this browser tab; resume the agent to act' })
      } else if (index === 2) {
        assert.equal(operation.kind, 'snapshot')
        await send({ type: 'browser-preview-result', requestId: input.requestId, ok: true,
          result: { ...status, page: { text: 'Observed during takeover', elements: [], frames: [] } } })
      } else {
        assert.equal(index, 3)
        assert.equal(operation.kind, 'evaluate')
        await send({ type: 'browser-preview-result', requestId: input.requestId, ok: true, result: { value: 'Resumed browser agent' } })
      }
    },
  }
  return driver
}
