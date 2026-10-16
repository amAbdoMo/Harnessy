import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import LlmRuntime, { createUserMessage, LlmAdapter  } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SessionTitleService from '@deepseek-ai/dsh-session-title'
import * as firstPromptProvider from '@deepseek-ai/dsh-session-title-first-prompt-llm'
import * as allPromptsProvider from '@deepseek-ai/dsh-session-title-all-prompts-llm'
import { turnBoundaryProjectionDefinition } from '@deepseek-ai/dsh-agent-loop'

let root: string | undefined
let context: Context | undefined

class LoaderAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    yield { type: 'text-delta', index: 0, text: 'Loader composed title' }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

async function loadComposition(cadence: 'first-prompt' | 'all-prompts'): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'dsh-title-loader-'))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-llm'",
    "- name: '@deepseek-ai/dsh-session'",
    "- name: '@deepseek-ai/dsh-session-projection'",
    "- name: '@deepseek-ai/dsh-session-title'",
    '  config:',
    '    fallbackMaxWords: 5',
    '    fallbackMaxBytes: 40',
    '    maxTitleBytes: 80',
    `- name: '@deepseek-ai/dsh-session-title-${cadence}-llm'`,
    '  config:',
    '    targetWords: 5',
    '    targetCjkCharacters: 10',
    '    maxInputBytes: 1000',
    '    maxOutputTokens: 32',
    '    timeoutMs: 1000',
    "    provider: 'title-route'",
    "    model: 'title-model'",
    '',
  ].join('\n'))

  context = new Context()
  context.baseUrl = pathToFileURL(root).href + '/'
  await context.plugin(Loader)
  context.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-llm', LlmRuntime],
    ['@deepseek-ai/dsh-session', SessionStore],
    ['@deepseek-ai/dsh-session-projection', SessionProjectionRegistry],
    ['@deepseek-ai/dsh-session-title', SessionTitleService],
    ['@deepseek-ai/dsh-session-title-first-prompt-llm', firstPromptProvider],
    ['@deepseek-ai/dsh-session-title-all-prompts-llm', allPromptsProvider],
  ])
  context.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof context.loader.internal>
  await context.loader.create({
    name: 'cordis:include',
    config: { path: pathToFileURL(configPath).href },
  })
  await context.loader.await()
  context.sessionProjections.register(turnBoundaryProjectionDefinition)
  return context
}

describe('session-title Loader composition', () => {
  it.each(['first-prompt', 'all-prompts'] as const)('loads the %s provider and retains its configured anchoring policy', async (cadence) => {
    const ctx = await loadComposition(cadence)
    const unloaded = [...ctx.loader.entries()]
      .filter(entry => entry.fiber === undefined && !entry.disabled)
      .map(entry => entry.options.name)
    expect(unloaded).toEqual([])

    const adapter = new LoaderAdapter()
    ctx.llm.registerAdapter(['title-route'], adapter)
    const session = ctx.sessions.create(SessionId('loader-title'))
    session.append('turn/start', {
      turn: 1,
    })
    const message = session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'Compose a title through Loader' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    await new Promise(resolve => setTimeout(resolve, 0))
    session.append('request/header', {
      header: { config: { provider: 'main-route', model: 'main-model' } },
      reason: 'initial',
    })
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(adapter.requests[0]).toMatchObject({ provider: 'title-route', model: 'title-model' })
    expect(ctx.sessionTitle.get(session)).toMatchObject({
      title: 'Loader composed title',
      messageSeqs: [message.seq],
      source: {
        kind: 'provider',
        provider: `session-title-${cadence}-llm`,
        model: { provider: 'title-route', model: 'title-model' },
      },
    })
    await ctx.sessionTitle.refresh(session)
    expect(adapter.requests).toHaveLength(2)
    const input = adapter.requests[1]?.messages[0]?.content[0]
    if (input?.type !== 'text') throw new Error('expected title input')
    const messages = [{ seq: message.seq, text: 'Compose a title through Loader' }]
    expect(input.text).toBe(cadence === 'all-prompts'
      ? `Update the session title from this JSON object:\n${JSON.stringify({ currentTitle: 'Loader composed title', messages })}`
      : `Generate the session title from this JSON array of human messages:\n${JSON.stringify(messages)}`)
    expect(adapter.requests[1]?.system?.includes('An existing title is supplied')).toBe(cadence === 'all-prompts')
    const recorded = session.snapshotEvents().filter(event => event.type === 'session/title-llm-request').at(-1)
    expect(recorded?.data).toMatchObject({
      config: { provider: 'title-route', model: 'title-model', maxTokens: 32 },
      messages: adapter.requests[1]?.messages,
      system: adapter.requests[1]?.system,
    })
  })
})
