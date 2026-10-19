/** Source-only Loader assembly with real Session services and private temporary stores. */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import Credentials from '@deepseek-ai/dsh-credentials-local'
import Sessions from '@deepseek-ai/dsh-session'
import Agents from '@deepseek-ai/dsh-agent'
import SessionQuery from '@deepseek-ai/dsh-session-query'
import SessionController from '@deepseek-ai/dsh-api-session-controller'
import SessionProjections from '@deepseek-ai/dsh-session-projection'
import AgentDefaultModel from '@deepseek-ai/dsh-agent-default-model'
import Llm from '@deepseek-ai/dsh-llm'
import Attachments from '@deepseek-ai/dsh-attachment-local'
import FileUploads from '@deepseek-ai/dsh-client-file-upload'
import * as Connection from '@deepseek-ai/dsh-client-connection'
import Commands from '@deepseek-ai/dsh-commands'
import Fs from '@deepseek-ai/dsh-fs-local'
import Typert from '@deepseek-ai/dsh-typert-registry'
import Workspace from '@deepseek-ai/dsh-workspace'
import * as Persistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import CompanionHost, { installDesktopCompanionOwner } from '../src/index.ts'
import type { Config } from '../src/config.ts'

/** Explicit deployed limits; no environment or shipped profile is consulted. */
export const config = {
  httpsOrigin: 'https://relay.invalid',
  budgets: {
    channel: { maxQueuedSendBytes: 65536, maxQueuedReceiveBytes: 65536,
      maxPendingSends: 20, maxPendingReceives: 20, sendTimeoutMs: 10000 },
    application: { maxRequestBytes: 4096, maxResultBytes: 4096, maxTextBytes: 1024, maxTitleBytes: 128,
      maxRows: 10, maxSessions: 10, maxSubscriptionsPerGrant: 2, maxPendingSubmissionsPerGrant: 2,
      readTimeoutMs: 10000, subscriptionLifetimeMs: 60000 },
    maxChannels: 4, maxChannelAttempts: 20, maxCandidates: 4, maxGrants: 4,
    maxRecordBytes: 32768, maxFrameBytes: 98304, maxSendQueuedBytes: 262144,
    maxPendingMessages: 20, maxProgressBuffer: 8, bytesPerSecond: 1000000,
    invitationLifetimeMs: 60000, handshakeTimeoutMs: 60000, connectionTimeoutMs: 60000,
    maxConnectionLifetimeMs: 120000, idleTimeoutMs: 60000,
    reconnectInitialMs: 1000, reconnectMaxMs: 1000, reconnectAttempts: 1,
  },
} satisfies Config

/** Fixture resources retained until root-fiber disposal reaches quiescence. */
export interface Composition {
  readonly ctx: Context
  readonly home: string
  readonly owner: AbortController
  close(): Promise<void>
}

/**
 * @param override - Companion deployment configuration.
 * @param sharedHome - Same canonical home for ownership contention.
 * @returns A real source Loader tree and its disposer.
 */
export async function composition(override: Config = config, sharedHome?: string): Promise<Composition> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-companion-host-'))
  const home = sharedHome ?? join(directory, 'home')
  const ctx = new Context()
  const owner = new AbortController()
  let closed = false
  const close = async (): Promise<void> => {
    if (closed) return
    closed = true
    try { await ctx.fiber.dispose() }
    finally { await rm(directory, { recursive: true, force: true }) }
  }
  try {
    installDesktopCompanionOwner(ctx, { home, signal: owner.signal })
    const modules = new Map<string, unknown>([
      ['credentials', Credentials], ['sessions', Sessions], ['agents', Agents], ['query', SessionQuery],
      ['projections', SessionProjections], ['model', AgentDefaultModel], ['llm', Llm],
      ['attachments', Attachments], ['uploads', FileUploads], ['connection', Connection], ['commands', Commands],
      ['fs', Fs], ['typert', Typert], ['workspace', Workspace], ['persistence', Persistence],
      ['storage', Storage], ['storage-json', StorageJson], ['storage-domain', StorageDomain],
      ['controller', SessionController], ['companion', CompanionHost],
    ])
    const configurations: Record<string, object> = {
      credentials: { path: join(home, 'test-credentials.yaml'), watch: false },
      model: { provider: 'fixture', model: 'fixture' },
      attachments: { dshHome: home, maxMessageImageBytes: 1024 }, fs: { cwd: directory },
      persistence: { root: join(directory, 'sessions'), compression: 'none' },
      'storage-json': { root: join(directory, 'storage') }, 'storage-domain': { backend: 'json' },
      controller: { nativeOpen: false }, companion: override,
    }
    const yaml = join(directory, 'cordis.yml')
    await writeFile(yaml, [...modules.keys()].map(id =>
      `- id: ${id}\n  name: 'fixture:${id}'\n  config: ${JSON.stringify(configurations[id] ?? {})}\n`).join(''))
    ctx.baseUrl = pathToFileURL(directory).href + '/'
    await ctx.plugin(Loader)
    ctx.loader.builtins.include = Include
    ctx.loader.internal = {
      version: 'v2', loadCache: new Map(),
      import: async (specifier) => {
        const plugin = modules.get(specifier.replace(/^fixture:/, ''))
        if (plugin === undefined) throw new Error(`Unexpected fixture source import ${specifier}`)
        return plugin
      },
      register(): never { throw new Error('Unexpected Node module hook registration') },
      getOrCreateModuleJob(): never { throw new Error('Unexpected Node module job') },
      resolveSync(): never { throw new Error('Unexpected synchronous resolution') },
      load(): never { throw new Error('Unexpected Node module load') },
    }
    await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(yaml).href } })
    await ctx.loader.await()
    return { ctx, home, owner, close }
  } catch (error) { await close(); throw error }
}
