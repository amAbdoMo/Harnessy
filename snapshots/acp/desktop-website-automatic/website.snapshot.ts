/** Keyless Automatic/Disabled website access through the actual CLI and shipped ACP profile. */
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join, resolve } from 'node:path'
import { expect, it } from 'vitest'
import {
  runScenario, normalizeSessionSnapshots, normalizeStdout, normalizedToolSchemas, normalizedSystemPrompts,
  redactSessionSnapshotIds, scrubSessionSnapshot, tokenizeSessionFixtureCwd, sessionFixtureName,
  sessionHeaderVersion, stabilizeFixtureMessageIds, formatSystemPromptSnapshot, formatToolSchemasSnapshot,
  type InputStep, type RunOptions,
} from '@deepseek-ai/dsh-session-snapshot'
import { parseSessionLog } from '@deepseek-ai/dsh-llm-replay'

const dir = fileURLToPath(new URL('.', import.meta.url))
const root = resolve(dir, '../../..')
const fixtureFile = join(dir, 'session.v4.jsonl')
const mode = process.env.DSH_SNAPSHOT ?? 'replay'
assert.ok(['record', 'refresh', 'replay'].includes(mode), 'Unknown snapshot mode')
const recording = mode === 'record'
const updating = mode !== 'replay'

it('desktop website automatic access bypasses policy never while disabled access fails before dispatch', async () => {
  const prompts = recording ? ['Use the Automatic saved website, read its page info, then verify Disabled saved access is refused.']
    : parseSessionLog(await readFile(fixtureFile, 'utf8'))
      .filter(event => event.type === 'user/message' && event.data.source?.kind === 'user')
      .map(event => {
        assert.equal(event.type, 'user/message')
        const block = event.data.content[0]
        assert.ok(block && block.type === 'text')
        return block.text
      })
  expect(prompts).toHaveLength(1)
  const driver = websiteAutomaticDriver()
  const result = await runScenario({ steps: [
    { op: 'initialize' }, { op: 'newSession' }, ...prompts.map(text => ({ op: 'prompt', text } as const)),
  ] }, {
    agent: { binScript: join(root, 'apps/cli/src/bin.ts'), profile: 'acp',
      configPath: join(dir, 'cordis.yml'), tsconfigPath: join(root, 'tsconfig.json') },
    mode: recording ? 'record' : 'replay', fixtureFile, privateDriver: driver,
    env: { DEEPSEEK_API_KEY: undefined, OPENAI_API_KEY: undefined, ANTHROPIC_API_KEY: undefined },
  })
  expect(driver.operations).toBe(1)
  expect(driver.controls).toEqual(['sync', 'validate', 'commit', 'revoke', 'drain', 'remove'])
  expect(result.rawStdout).not.toContain('session/request_permission')
  expect(result.sessionLogs).toHaveLength(1)
  const log = result.sessionLogs[0]
  assert.ok(log)
  expect(log.content).toContain('Saved website access is ready for this request.')
  expect(log.content).toContain('Saved website access is disabled')
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
    await writeFile(join(dir, sessionFixtureName(0, sessionHeaderVersion(log.content, 'website automatic CLI session'))), output)
    for (const [name, content] of Object.entries(sidecars)) await writeFile(join(dir, name), content)
  } else {
    const fixture = await readFile(fixtureFile, 'utf8')
    expect(sessions).toEqual(normalizeSessionSnapshots([fixture], { cwd: '{{cwd}}', sessionIds: [] }, { nativeWriterOutput: true }))
    for (const [name, content] of Object.entries(sidecars)) expect(content).toBe(await readFile(join(dir, name), 'utf8'))
  }
})

function packet(value: unknown): Record<string, unknown> {
  assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value))
  return value as Record<string, unknown>
}

function websiteAutomaticDriver(): NonNullable<RunOptions['privateDriver']> & { operations: number; controls: string[] } {
  let prepared: Record<string, unknown> | undefined
  let sequence = 0
  const pending = new Map<number, (message: Record<string, unknown>) => void>()
  const driver = {
    operations: 0,
    controls: [] as string[],
    async command(send: (message: object) => Promise<void>, action: string, fields: object): Promise<Record<string, unknown>> {
      driver.controls.push(action)
      const requestId = ++sequence
      const response = Promise.withResolvers<Record<string, unknown>>()
      pending.set(requestId, message => {
        if (message.error !== undefined) response.reject(new Error(String(message.error)))
        else response.resolve(message)
      })
      try {
        await send({ type: 'website-control', requestId, command: { action, ...fields } })
        return await response.promise
      } finally { pending.delete(requestId) }
    },
    async receive(value: unknown, send: (message: object) => Promise<void>): Promise<void> {
      const message = packet(value)
      if (message.type === 'website-control') {
        assert.equal(typeof message.requestId, 'number')
        const respond = pending.get(message.requestId as number)
        assert.ok(respond)
        respond(message)
        return
      }
      if (message.type === 'website-prepared') {
        assert.equal(prepared, undefined)
        prepared = packet(message.snapshot)
        await send({ type: 'website-prepared-ack', id: prepared.id })
        await driver.command(send, 'validate', { id: prepared.id, epoch: prepared.epoch })
        const committed = await driver.command(send, 'commit', { id: prepared.id, epoch: prepared.epoch })
        assert.equal(packet(committed.snapshot).status, 'granted')
        return
      }
      if (message.type === 'website-check') {
        assert.ok(prepared)
        await send({ type: 'website-check-result', requestId: message.requestId, accepted: true })
        return
      }
      if (message.type === 'website-operation') {
        assert.ok(prepared)
        assert.equal(message.operation, 'page-info')
        driver.operations++
        await send({ type: 'website-operation-result', operationId: message.operationId, snapshot: message.snapshot,
          outcome: 'success', value: { origin: 'https://website.example', title: 'Saved guest page', titleTruncated: false } })
        return
      }
      if (message.type === 'website-revoked') return
      assert.fail(`Unexpected private website packet ${String(message.type)}`)
    },
    async afterStep(step: InputStep, send: (message: object) => Promise<void>): Promise<void> {
      if (step.op === 'newSession') {
        await driver.command(send, 'sync', { profiles: [
          { id: '11111111-1111-4111-8111-111111111111', name: 'Automatic website', accountLabel: 'Saved account',
            url: 'https://website.example', serverName: 'saved-site', access: 'automatic',
            mcpBinding: { identity: 'a'.repeat(64), endpoint: 'https://website.example/mcp' } },
          { id: '22222222-2222-4222-8222-222222222222', name: 'Disabled website', accountLabel: 'Blocked account',
            url: 'https://disabled.example', serverName: 'disabled-site', access: 'disabled',
            mcpBinding: { identity: 'b'.repeat(64), endpoint: 'https://disabled.example/mcp' } },
        ] })
      }
      if (step.op !== 'prompt') return
      assert.ok(prepared)
      await driver.command(send, 'revoke', { id: prepared.id })
      await driver.command(send, 'drain', { id: prepared.id })
      await driver.command(send, 'remove', { id: prepared.id })
    },
  }
  return driver
}
