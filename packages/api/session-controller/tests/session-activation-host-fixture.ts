/** Source Loader composition with real API, Agent, projection, Workspace and JSONL owners. */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader, { type ModuleLoaderV2 } from '@deepseek-ai/cordis-plugin-loader'
import { mountRootInclude } from '@deepseek-ai/dsh-app-boot'
import AgentRegistry, { type CreateAgentOptions } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import AgentDefaultModel from '@deepseek-ai/dsh-agent-default-model'
import AttachmentStore from '@deepseek-ai/dsh-attachment'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import FileUploads from '@deepseek-ai/dsh-client-file-upload'
import type { HostConnectionHandle } from '@deepseek-ai/dsh-client-connection'
import LlmRuntime, { createUserMessage, LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmModelInfo, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import AgentPresetRegistry from '@deepseek-ai/dsh-agent-preset-registry'
import SessionStore, { SESSION_FORMAT_VERSION, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import * as JsonlPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { generationLogPath } from '@deepseek-ai/dsh-session-persistence-jsonl/src/format.ts'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SessionQuery from '@deepseek-ai/dsh-session-query'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import WorkspaceRegistry from '@deepseek-ai/dsh-workspace'
import { onTestFinished } from 'vitest'
import { MemoryMediaPool, MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import SessionController from '../src/index.ts'

/** Deterministic storage or plugin initialization pause, released during fixture cleanup. */
export class ActivationBarrier {
  private readonly arrival = Promise.withResolvers<undefined>()
  private readonly completion = Promise.withResolvers<undefined>()
  readonly arrived = this.arrival.promise

  async enter(): Promise<void> {
    this.arrival.resolve(undefined)
    await this.completion.promise
  }

  release(): void { this.completion.resolve(undefined) }
}

/** Metadata-only external model; accidental activation of a task fails instead of contacting a provider. */
class ActivationModel extends LlmAdapter {
  override listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    return Promise.resolve([{ provider, id: 'other-model', name: 'Other model' }])
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model })
  }

  override stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    throw new Error('activation must not generate a model response')
  }
}

/** External binary backend; this fixture never accepts attachments. */
class ActivationAttachments extends AttachmentStore {
  readonly imageLimits = {
    maxImageBytes: 1024, maxImagesPerMessage: 2, maxMessageImageBytes: 2048,
    maxImagePixels: 4, maxImageDimension: 2, mediaTypes: ['image/png'] as const,
  }
  override validateImage(): Promise<never> { return Promise.reject(new Error('no fixture image input')) }
  override saveImage(): Promise<never> { return Promise.reject(new Error('no fixture image storage')) }
  override readImage(): Promise<never> { return Promise.reject(new Error('no fixture image reads')) }
}

/**
 * Compose source modules through a real Loader, with no server, Desktop follower or provider launch.
 * @returns the actual service owners and isolated durable conversation helpers.
 */
export async function sessionActivationComposition() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-session-activation-'))
  const ctx = new Context()
  const barriers: ActivationBarrier[] = []
  onTestFinished(async () => {
    for (const barrier of barriers) barrier.release()
    try { await ctx.fiber.dispose() }
    finally { await rm(root, { recursive: true, force: true }) }
  })
  const model = new ActivationModel()
  let controller: SessionController | undefined
  let apiOwner: Context | undefined
  const transport = {
    name: 'fixture-transport',
    apply(owner: Context) {
      const connection: Pick<HostConnectionHandle, 'fetch'> = { fetch: { register: () => async () => {} } }
      owner.provide('connection', connection)
    },
  }
  const domains = {
    name: 'fixture-domains', inject: ['storage'],
    apply(owner: Context) {
      owner.effect(() => owner.storage.backend.register('memory', new MemoryStorageBackend(new MemoryMediaPool())))
      const facility = new DomainFacility(owner, { backend: 'memory', routes: {} })
      owner.storage.mount('domain', facility)
      owner.provide('storageDomain', facility)
    },
  }
  const definitions = {
    name: 'fixture-presets', inject: ['agentPresets'],
    async apply(owner: Context) {
      owner.effect(() => owner.agentPresets.register({ id: 'initial-preset', plugins: [] }))
      owner.effect(() => owner.agentPresets.register({ id: 'selected-preset', plugins: [] }))
    },
  }
  const owner = {
    name: 'activation-api-owner',
    inject: ['agents', 'agentDefaultModel', 'sessions', 'sessionQuery', 'llm', 'attachments',
      'fileUploads', 'sessionProjections', 'typert', 'workspaceRegistry'],
    apply(ownerContext: Context) {
      apiOwner = ownerContext
      controller = new SessionController(ownerContext, {})
      ownerContext.effect(() => ownerContext.llm.registerAdapter(['fixture'], model))
    },
  }
  const modules = new Map<string, unknown>([
    ['typert', TypertRegistry], ['sessions', SessionStore], ['projections', SessionProjectionRegistry],
    ['llm', LlmRuntime], ['agents', AgentRegistry], ['system-prompt', SystemPrompt], ['tools', ToolRuntime],
    ['loop', AgentLoop], ['attachments', ActivationAttachments], ['commands', CommandRuntime],
    ['transport', transport], ['uploads', FileUploads], ['default-model', AgentDefaultModel],
    ['persistence', JsonlPersistence], ['query', SessionQuery], ['storage', Storage], ['domains', domains],
    ['workspace', WorkspaceRegistry], ['presets', AgentPresetRegistry], ['definitions', definitions], ['owner', owner],
  ])
  const rows = [...modules.keys()].map(name => ({
    id: name, name,
    ...name === 'loop' ? { config: { agents: [] } } : {},
    ...name === 'default-model' ? { config: { provider: 'fixture', model: 'fixture-model' } } : {},
    ...name === 'persistence' ? { config: { root: join(root, 'sessions'), compression: 'none' } } : {},
    ...name === 'presets' ? { config: { default: 'initial-preset' } } : {},
  }))
  const profile = join(root, 'profile')
  await mkdir(profile)
  const configPath = join(profile, 'cordis.yml')
  await writeFile(configPath, JSON.stringify(rows) + '\n')
  ctx.baseUrl = pathToFileURL(profile).href + '/'
  await ctx.plugin(Loader)
  const internal: ModuleLoaderV2 = {
    version: 'v2', loadCache: new Map(),
    import: async (specifier: string) => {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
    register(): never { throw new Error('unexpected module hook registration') },
    getOrCreateModuleJob(): never { throw new Error('unexpected module job creation') },
    resolveSync(): never { throw new Error('unexpected synchronous module resolution') },
    load(): never { throw new Error('unexpected module load') },
  }
  ctx.loader.internal = internal
  await mountRootInclude(ctx, configPath)
  await ctx.loader.await()
  const inactive = [...ctx.loader.entries()].filter(entry => entry.fiber === undefined && !entry.disabled)
  if (inactive.length > 0) throw new Error(`unloaded fixture entries: ${inactive.map(entry => entry.options.name).join(', ')}`)
  if (controller === undefined || apiOwner === undefined) throw new Error('activation API owner did not load')
  const api = controller
  const ownerContext = apiOwner
  const events = async (id: SessionId): Promise<readonly SessionEvent[]> => {
    using observation = await ctx.sessionQuery.observeSession(id, { projectionMode: 'none' })
    return [...observation.events]
  }
  const persist = async (id: SessionId, meta: CreateAgentOptions['meta'] = { cwd: root }) => {
    const handle = await ctx.agents.create({
      sessionId: id, meta: { agentPreset: 'initial-preset', ...meta },
      agentOptions: { provider: 'fixture', model: 'fixture-model' },
    })
    handle.agent.session.append('agent-preset/selected', { agentPreset: 'selected-preset' })
    handle.agent.session.append('turn/start', { turn: 1 })
    handle.agent.session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: `Existing conversation ${id}` }], source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    handle.agent.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    await ctx.sessions.flush(handle.agent.session)
    await handle.dispose()
    return id
  }
  const seedColdSession = async (id: SessionId, cwd: string, content: string): Promise<string> => {
    const path = generationLogPath(join(root, 'sessions'), cwd, id, SESSION_FORMAT_VERSION, 'none')
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, content, { flag: 'wx' })
    return path
  }
  return {
    ctx, controller: api, model, root, events, persist, seedColdSession,
    disposeApi: () => ownerContext.fiber.dispose(),
    barrier: () => {
      const barrier = new ActivationBarrier()
      barriers.push(barrier)
      return barrier
    },
  }
}
