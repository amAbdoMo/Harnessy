/** Source-only Loader fixture with real command, Agent, inbox, projection, and JSONL owners. */
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
import AttachmentStore, { AttachmentId } from '@deepseek-ai/dsh-attachment'
import type {
  FileAttachmentRef, ImageAttachmentRef, SaveFileAttachment, SaveImageAttachment, StoredImageAttachment,
} from '@deepseek-ai/dsh-attachment'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import FileUploads from '@deepseek-ai/dsh-client-file-upload'
import type { HostConnectionHandle } from '@deepseek-ai/dsh-client-connection'
import LlmRuntime, { LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import JsonlPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import { onTestFinished } from 'vitest'
import { ApiSessionAgentController } from '../src/agent.ts'
import { SessionCommandController } from '../src/commands.ts'
import { SessionControlController } from '../src/control.ts'
import { installModelSelectionProjection } from '../src/model-selection-projection.ts'
import type { SessionPromptRequest, SessionPromptValue } from '../src/types.ts'

/** Deterministic pause at an external provider or storage operation. */
export class AdmissionBarrier {
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

class AdmissionModel extends LlmAdapter {
  modelBarrier: AdmissionBarrier | undefined
  streamBarrier: AdmissionBarrier | undefined

  override async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    await this.modelBarrier?.enter()
    return { provider, id: model, name: model, inputModalities: ['text', 'image'] }
  }

  override async *stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    await this.streamBarrier?.enter()
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'completed' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'completed' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

/** In-memory binary backend; admission and batch processing remain inherited real behavior. */
class AdmissionStorage extends AttachmentStore {
  readonly imageLimits = {
    maxImageBytes: 1024, maxImagesPerMessage: 2, maxMessageImageBytes: 2048,
    maxImagePixels: 4, maxImageDimension: 2, mediaTypes: ['image/png'] as const,
  }
  saveBarrier: AdmissionBarrier | undefined
  saved = false
  private readonly images = new Map<ImageAttachmentRef, Uint8Array>()

  override validateImage(_input: SaveImageAttachment): Promise<void> {
    return Promise.resolve()
  }

  override async saveImage(input: SaveImageAttachment): Promise<ImageAttachmentRef> {
    await this.saveBarrier?.enter()
    const ref: ImageAttachmentRef = {
      attachmentId: AttachmentId(`fixture-image-${String(this.images.size)}`),
      mediaType: input.mediaType, bytes: input.data.byteLength, width: 1, height: 1,
    }
    this.images.set(ref, input.data.slice())
    this.saved = true
    return ref
  }

  override saveFile(input: SaveFileAttachment): Promise<FileAttachmentRef> {
    return Promise.resolve({
      attachmentId: AttachmentId('fixture-file'), name: input.name ?? 'file', bytes: input.data.byteLength,
    })
  }

  override readImage(ref: ImageAttachmentRef): Promise<StoredImageAttachment> {
    const data = this.images.get(ref)
    if (data === undefined) return Promise.reject(new Error('missing fixture image'))
    return Promise.resolve({ ref, data: data.slice() })
  }
}

/**
 * Load test-only cordis.yml using source modules, without starting a server or app.
 * @returns isolated command/control owners and external await barriers.
 */
export async function promptAdmissionComposition() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-prompt-admission-'))
  const ctx = new Context()
  const model = new AdmissionModel()
  const barriers: AdmissionBarrier[] = []
  const pending = new Set<Promise<SessionPromptValue>>()
  onTestFinished(async () => {
    for (const barrier of barriers) barrier.release()
    await Promise.allSettled([...pending])
    try {
      await ctx.fiber.dispose()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
  let commands: SessionCommandController | undefined
  let agentController: ApiSessionAgentController | undefined
  let control: SessionControlController | undefined
  let storage: AdmissionStorage | undefined
  const externalTransport = {
    name: 'fixture-transport',
    apply(owner: Context) {
      // Only the external HTTP route registration is replaced; FileUploads stays real.
      const transport: Pick<HostConnectionHandle, 'fetch'> = { fetch: { register: () => async () => {} } }
      owner.provide('connection', transport)
    },
  }
  const owner = {
    name: 'prompt-admission-owner',
    inject: ['agents', 'agentDefaultModel', 'sessions', 'llm', 'attachments', 'fileUploads', 'sessionProjections', 'typert'],
    apply(ownerContext: Context) {
      installModelSelectionProjection(ownerContext)
      const agents = new ApiSessionAgentController(ownerContext)
      agentController = agents
      commands = new SessionCommandController(ownerContext, agents, root)
      control = new SessionControlController(ownerContext)
      ownerContext.effect(() => ownerContext.llm.registerAdapter(['fixture'], model))
      const installed = ownerContext.attachments
      if (!(installed instanceof AdmissionStorage)) throw new Error('fixture storage was not loaded')
      storage = installed
    },
  }
  const modules = new Map<string, unknown>([
    ['typert', TypertRegistry], ['sessions', SessionStore], ['projections', SessionProjectionRegistry],
    ['llm', LlmRuntime], ['agents', AgentRegistry], ['system-prompt', SystemPrompt],
    ['tools', ToolRuntime], ['loop', AgentLoop], ['attachments', AdmissionStorage],
    ['commands', CommandRuntime], ['transport', externalTransport], ['uploads', FileUploads],
    ['default-model', AgentDefaultModel], ['persistence', JsonlPersistence], ['owner', owner],
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
  if (commands === undefined || control === undefined || storage === undefined || agentController === undefined) throw new Error('admission owner did not load')
  const commandOwner = commands
  const { agent } = await ctx.agents.create({
    sessionId: SessionId('admission-session'), meta: { cwd: root },
    agentOptions: { provider: 'fixture', model: 'fixture-model' },
  })
  return {
    ctx, agent, agents: agentController, control, model, storage,
    barrier: () => {
      const barrier = new AdmissionBarrier()
      barriers.push(barrier)
      return barrier
    },
    prompt: (request: SessionPromptRequest, checkAdmission: () => void) => {
      const task = commandOwner.prompt(request, checkAdmission)
      pending.add(task)
      void task.then(() => pending.delete(task), () => pending.delete(task))
      return task
    },
  }
}
