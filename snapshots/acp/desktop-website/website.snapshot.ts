/** Keyless website recording/replay through the actual CLI and shipped ACP profile. */
import assert from 'node:assert/strict'
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join, resolve } from 'node:path'
import { expect, it } from 'vitest'
import {
  runScenario, normalizeSessionSnapshots, normalizeStdout, normalizedToolSchemas, normalizedSystemPrompts,
  redactSessionSnapshotIds, scrubSessionSnapshot, tokenizeSessionFixtureCwd, sessionFixtureName,
  sessionHeaderVersion, sessionFixtureFiles, stabilizeFixtureMessageIds,
  formatSystemPromptSnapshot, formatToolSchemasSnapshot, type InputStep, type RunOptions,
} from '@deepseek-ai/dsh-session-snapshot'
import { parseSessionLog } from '@deepseek-ai/dsh-llm-replay'

const dir = fileURLToPath(new URL('.', import.meta.url))
const root = resolve(dir, '../../..')
const mode = process.env.DSH_SNAPSHOT ?? 'replay'
assert.ok(['record', 'refresh', 'replay'].includes(mode), 'Unknown snapshot mode')
const recording = mode === 'record'
const updating = mode !== 'replay'

it('desktop website: real preparation, Human Resume, allow_once, fresh denial and quiescent Takeover', async () => {
  const selected = sessionFixtureFiles(await readdir(dir))[0]
  assert.ok(selected, 'Missing website Session fixture')
  const fixtureFile = join(dir, selected.name)
  const fixture = await readFile(fixtureFile, 'utf8')
  const prompts = parseSessionLog(fixture)
    .filter(event => event.type === 'user/message' && event.data.source?.kind === 'user')
    .map(event => {
      assert.equal(event.type, 'user/message')
      const block = event.data.content[0]
      assert.ok(block && block.type === 'text')
      return block.text
    })
  expect(prompts).toHaveLength(4)
  const driver = websiteDriver()
  const result = await runScenario({ steps: [
    { op: 'initialize' }, { op: 'newSession' }, ...prompts.map(text => ({ op: 'prompt', text } as const)),
  ], permissionAnswers: [{ kind: 'allow_once' }, { kind: 'allow_once' }, { kind: 'reject_once' }] }, {
    agent: { binScript: join(root, 'apps/cli/src/bin.ts'), profile: 'acp',
      configPath: join(dir, 'cordis.yml'), tsconfigPath: join(root, 'tsconfig.json') },
    mode: recording ? 'record' : 'replay', fixtureFile, privateDriver: driver,
    env: { DEEPSEEK_API_KEY: undefined, OPENAI_API_KEY: undefined, ANTHROPIC_API_KEY: undefined },
  })
  expect(driver.operations).toBe(2)
  expect(driver.controls).toEqual(['sync', 'validate', 'commit', 'revoke', 'drain', 'remove'])
  expect(result.sessionLogs).toHaveLength(1)
  const log = result.sessionLogs[0]
  assert.ok(log)
  expect(log.content).not.toContain('UNKNOWN_TOOL')
  expect(log.content).toContain('Waiting for the human to Resume this request. No page access is granted.')
  expect(log.content).toContain('Saved guest page')
  const ctx = { cwd: result.cwd, cwdAliases: result.cwdAliases, sessionIds: result.sessionLogs.map(item => item.id) }
  const sessions = normalizeSessionSnapshots(result.sessionLogs.map(item => item.content), ctx, { nativeWriterOutput: true })
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
    await writeFile(join(dir, sessionFixtureName(0, sessionHeaderVersion(log.content, 'website CLI session'))), output)
    for (const [name, content] of Object.entries(sidecars)) await writeFile(join(dir, name), content)
  } else {
    expect(sessions).toEqual(normalizeSessionSnapshots([fixture], { cwd: '{{cwd}}', sessionIds: [] }, { nativeWriterOutput: true }))
    for (const [name, content] of Object.entries(sidecars)) expect(content).toBe(await readFile(join(dir, name), 'utf8'))
  }
})

function packet(value: unknown): Record<string, unknown> {
  assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value))
  return value as Record<string, unknown>
}

function websiteDriver(): NonNullable<RunOptions['privateDriver']> & { operations: number; controls: string[] } {
  let prepared: Record<string, unknown> | undefined
  let prompt = 0
  let sequence = 0
  const pending = new Map<number, (message: Record<string, unknown>) => void>()
  const driver = {
    operations: 0,
    controls: [] as string[],
    async receive(value: unknown, send: (message: object) => Promise<void>): Promise<void> {
      const message = packet(value)
      switch (message.type) {
        case 'website-control': {
          assert.equal(typeof message.requestId, 'number')
          const respond = pending.get(message.requestId as number)
          assert.ok(respond)
          respond(message)
          break
        }
        case 'website-prepared': {
          assert.equal(prepared, undefined)
          prepared = packet(message.snapshot)
          assert.equal(prepared.status, 'pending')
          assert.equal(prepared.epoch, 1)
          assert.equal(driver.operations, 0)
          await send({ type: 'website-prepared-ack', id: prepared.id })
          break
        }
        case 'website-check': {
          assert.ok(prepared)
          const snapshot = packet(message.snapshot)
          assert.equal(snapshot.id, prepared.id)
          assert.equal(snapshot.sessionId, prepared.sessionId)
          await send({ type: 'website-check-result', requestId: message.requestId, accepted: true })
          break
        }
        case 'website-operation': {
          assert.ok(prepared)
          const snapshot = packet(message.snapshot)
          assert.equal(snapshot.id, prepared.id)
          assert.equal(snapshot.sessionId, prepared.sessionId)
          assert.equal(snapshot.status, 'granted')
          assert.equal(prompt, 1)
          if (driver.operations === 0) {
            assert.equal(message.operation, 'page-info')
            driver.operations++
            await send({ type: 'website-operation-result', operationId: message.operationId,
              snapshot, outcome: 'success', value: { origin: 'https://website.example', title: 'Saved guest page', titleTruncated: false } })
          } else {
            assert.equal(driver.operations, 1, 'Each observation requires independent consent')
            assert.deepEqual(message.operation, { kind: 'dom-read', selector: 'h1', maxElements: 1, maxTextChars: 64 })
            driver.operations++
            await send({ type: 'website-operation-result', operationId: message.operationId,
              snapshot, outcome: 'success', value: { kind: 'json', value: { elements: [{ tag: 'h1', text: 'Guest heading' }] } } })
          }
          break
        }
        case 'website-revoked': assert.equal(message.id, prepared?.id); break
        default: assert.fail(`Unexpected private website packet ${String(message.type)}`)
      }
    },
    async afterStep(step: InputStep, send: (message: object) => Promise<void>): Promise<void> {
      const command = async (action: string, fields: object): Promise<Record<string, unknown>> => {
        driver.controls.push(action)
        const requestId = ++sequence
        let timer: ReturnType<typeof setTimeout> | undefined
        const response = new Promise<Record<string, unknown>>((resolve, reject) => {
          timer = setTimeout(() => { reject(new Error(`Website private ${action} acknowledgement timed out`)) }, 10_000)
          pending.set(requestId, message => {
            if (message.error !== undefined) reject(new Error(String(message.error)))
            else resolve(message)
          })
        })
        // Retain the response even if OS delivery fails; join and dispose its waiter below.
        void response.catch(() => undefined)
        try { await send({ type: 'website-control', requestId, command: { action, ...fields } }); return await response }
        finally { clearTimeout(timer); pending.delete(requestId) }
      }
      if (step.op === 'newSession') {
        await command('sync', { profiles: [{ id: '11111111-1111-4111-8111-111111111111', name: 'Saved website',
          accountLabel: 'Human account', url: 'https://website.example', serverName: 'saved-site',
          mcpBinding: { identity: 'a'.repeat(64), endpoint: 'https://website.example/mcp' } }] })
      }
      if (step.op !== 'prompt') return
      prompt++
      assert.ok(prepared)
      if (prompt === 1) {
        assert.equal(driver.operations, 0)
        const validated = await command('validate', { id: prepared.id, epoch: prepared.epoch })
        assert.equal(packet(validated.snapshot).status, 'pending')
        const committed = await command('commit', { id: prepared.id, epoch: prepared.epoch })
        assert.equal(packet(committed.snapshot).status, 'granted')
      } else if (prompt === 3) {
        assert.equal(driver.operations, 2, 'Fresh reject_once must not execute another native observation')
        await command('revoke', { id: prepared.id })
        await command('drain', { id: prepared.id })
        await command('remove', { id: prepared.id })
      }
    },
  }
  return driver
}
