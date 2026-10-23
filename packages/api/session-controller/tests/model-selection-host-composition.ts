/** Source-only Loader fixture with the real Session Controller, Agent, inbox, projection, and JSONL owners. */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader, { type ModuleLoaderV2 } from '@deepseek-ai/cordis-plugin-loader'
import { mountRootInclude } from '@deepseek-ai/dsh-app-boot'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import AgentDefaultModel from '@deepseek-ai/dsh-agent-default-model'
import AttachmentStore from '@deepseek-ai/dsh-attachment'
import type { ImageAttachmentLimits } from '@deepseek-ai/dsh-attachment'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import FileUploads from '@deepseek-ai/dsh-client-file-upload'
import type { HostConnectionHandle } from '@deepseek-ai/dsh-client-connection'
import LlmRuntime, { LlmAdapter, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type {
  GenerateOptions, LlmModelInfo, LlmProviderInfo, LlmResolvedModelInfo, StreamChunk,
} from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import * as JsonlPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SessionQuery from '@deepseek-ai/dsh-session-query'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import { onTestFinished } from 'vitest'
import SessionController from '../src/index.ts'

/** Catalog route the fixture advertises without reasoning metadata. */
export const PLAIN_MODEL = 'plain-model'
/** Catalog route the fixture advertises with its own default reasoning effort. */
export const REASONING_MODEL = 'reasoning-model'
/** Catalog route whose exact-model metadata lookup fails. */
export const BROKEN_MODEL = 'broken-model'

/** Deterministic pause at the external model boundary. */
export class SelectionBarrier {
  private readonly arrival = Promise.withResolvers<undefined>()
  private readonly completion = Promise.withResolvers<undefined>()
  readonly arrived = this.arrival.promise

  async enter(): Promise<void> {
    this.arrival.resolve(undefined)
    await this.completion.promise
  }

  release(): void {
    this.completion.resolve(undefined)
  }
}

/** External model and catalog boundary: the only provider the fixture serves. */
class SelectionModel extends LlmAdapter {
  resolveBarrier: SelectionBarrier | undefined
  streamBarrier: SelectionBarrier | undefined
  readonly requests: Pick<GenerateOptions, 'provider' | 'model' | 'reasoningEffort'>[] = []

  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: provider }
  }

  override listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    return Promise.resolve([
      { provider, id: PLAIN_MODEL, name: 'Plain Model' },
      { provider, id: REASONING_MODEL, name: 'Reasoning Model' },
      { provider, id: BROKEN_MODEL, name: 'Broken Model' },
    ])
  }

  override async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    await this.resolveBarrier?.enter()
    if (model === BROKEN_MODEL) throw new Error('routing metadata offline')
    return {
      provider,
      id: model,
      name: model,
      ...(model === REASONING_MODEL
        ? {
          reasoning: {
            efforts: [
              { id: ReasoningEffortId('low'), name: 'Low' },
              { id: ReasoningEffortId('high'), name: 'High' },
            ],
            defaultEffort: ReasoningEffortId('high'),
          },
        }
        : {}),
    }
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push({ provider: options.provider, model: options.model,
      ...(options.reasoningEffort === undefined ? {} : { reasoningEffort: options.reasoningEffort }) })
    await this.streamBarrier?.enter()
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'completed' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'completed' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

const IMAGE_LIMITS: ImageAttachmentLimits = Object.freeze({
  maxImageBytes: 1024,
  maxImagesPerMessage: 2,
  maxMessageImageBytes: 2048,
  maxImagePixels: 4,
  maxImageDimension: 2,
  mediaTypes: Object.freeze(['image/png'] as const),
})

/** Typed external attachment backend; this model-selection fixture never admits binary content. */
class SelectionAttachments extends AttachmentStore {
  readonly imageLimits = IMAGE_LIMITS
  override validateImage(): Promise<void> { return Promise.reject(new Error('The fixture admits no images')) }
  override saveImage(): Promise<never> { return Promise.reject(new Error('The fixture stores no images')) }
  override readImage(): Promise<never> { return Promise.reject(new Error('The fixture reads no images')) }
}

/**
 * Load a test-only cordis.yml using source modules, without starting a server or app.
 * @returns the live Session Controller, its Agent, and the external model boundary.
 */
export async function modelSelectionComposition() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-model-selection-'))
  const ctx = new Context()
  const model = new SelectionModel()
  const barriers: SelectionBarrier[] = []
  onTestFinished(async () => {
    for (const barrier of barriers) barrier.release()
    try {
      await ctx.fiber.dispose()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
  let controller: SessionController | undefined
  const externalTransport = {
    name: 'fixture-transport',
    apply(owner: Context) {
      // Only the external HTTP route registration is replaced; FileUploads stays real.
      const transport: Pick<HostConnectionHandle, 'fetch'> = { fetch: { register: () => async () => {} } }
      owner.provide('connection', transport)
    },
  }
  const owner = {
    name: 'model-selection-owner',
    inject: ['agents', 'agentDefaultModel', 'sessions', 'sessionQuery', 'llm', 'attachments', 'fileUploads', 'sessionProjections', 'typert'],
    apply(ownerContext: Context) {
      controller = new SessionController(ownerContext, {})
      ownerContext.effect(() => ownerContext.llm.registerAdapter(['fixture'], model))
    },
  }
  const modules = new Map<string, unknown>([
    ['typert', TypertRegistry], ['sessions', SessionStore], ['projections', SessionProjectionRegistry],
    ['llm', LlmRuntime], ['agents', AgentRegistry], ['system-prompt', SystemPrompt],
    ['tools', ToolRuntime], ['loop', AgentLoop], ['attachments', SelectionAttachments],
    ['commands', CommandRuntime], ['transport', externalTransport], ['uploads', FileUploads],
    ['default-model', AgentDefaultModel], ['persistence', JsonlPersistence], ['query', SessionQuery], ['owner', owner],
  ])
  const rows = [...modules.keys()].map(name => ({
    id: name, name,
    ...name === 'loop' ? { config: { agents: [] } } : {},
    ...name === 'default-model' ? { config: { provider: 'fixture', model: 'fixture-model' } } : {},
    ...name === 'persistence' ? { config: { root: join(root, 'sessions'), compression: 'none' } } : {},
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
  if (controller === undefined) throw new Error('model selection owner did not load')
  const sessionController = controller
  const handle = await ctx.agents.create({
    sessionId: SessionId('model-selection-session'), meta: { cwd: root },
    agentOptions: { provider: 'fixture', model: 'fixture-model' },
  })
  return {
    ctx, agent: handle.agent, agentHandle: handle, controller: sessionController, model, cwd: root,
    events: async () => {
      using observation = await ctx.sessionQuery.observeSession(handle.agent.id, { projectionMode: 'none' })
      return [...observation.events]
    },
    barrier: () => {
      const barrier = new SelectionBarrier()
      barriers.push(barrier)
      return barrier
    },
  }
}
