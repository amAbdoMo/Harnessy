/**
 * Harnessy-owned global MCP server manager. Saved transport profiles and
 * authentication remain in protected credential storage; Remote responses
 * expose only connection state, endpoint labels, and registered tool names.
 *
 * @module @deepseek-ai/dsh-api-settings-controller/src/mcp-manager
 */

import { randomUUID } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import type { CredentialProvider, CredentialRecord } from '@deepseek-ai/dsh-credentials'
import {
  resolveReconnectPolicy, startManagedConnection,
} from '@deepseek-ai/dsh-mcp-client'
import type {
  Config as McpClientConfig, ConnectionHandle, ConnectionSnapshot,
} from '@deepseek-ai/dsh-mcp-client'
import { openNativeTextFile } from '@deepseek-ai/dsh-native-command'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type {
  McpManagerState, McpServerInput, McpServerStatus, McpServerView, SettingsDocumentOpenValue,
} from './types.ts'

const VAULT_KEY = credentialKey('mcp-manager', 'servers')
const SERVER_NAME = /^[A-Za-z0-9_-]{1,32}$/
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/
const MAX_SERVERS = 64
const MAX_SECRET_LENGTH = 16_384

interface StoredBase {
  readonly id: string
  readonly name: string
  readonly serverName: string
  readonly enabled: boolean
  readonly updatedAt: number
}

interface StoredHttpServer extends StoredBase {
  readonly transport: 'streamable-http'
  readonly url: string
  readonly headerName: string
  readonly authorization?: string
}

interface StoredStdioServer extends StoredBase {
  readonly transport: 'stdio'
  readonly command: string
  readonly args: readonly string[]
  readonly cwd: string
  readonly environment: Readonly<Record<string, string>>
}

type StoredServer = StoredHttpServer | StoredStdioServer

interface McpVault {
  readonly version: 1
  readonly servers: readonly StoredServer[]
}

interface RuntimeEntry {
  readonly token: symbol
  readonly profileKey: string
  readonly handle: ConnectionHandle
}

interface SynchronizedVault {
  readonly vault: McpVault
  readonly imported: boolean
}

/** Connection factory replaceable by Host unit tests. */
export interface McpManagerControllerInternals {
  readonly startConnection?: typeof startManagedConnection
  readonly configurationPath?: string
  readonly openTextFile?: (path: string, signal: AbortSignal) => Promise<void>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Host owner of the `mcpManager` Remote namespace. */
    mcpManagerController: McpManagerController
  }
}

/** Host controller for Harnessy's protected, live MCP server registry. */
export class McpManagerController extends TypertRemoteService {
  private runtimeContext: Context | undefined
  private readonly runtime = new Map<string, RuntimeEntry>()
  private readonly status = new Map<string, ConnectionSnapshot>()
  private queue: Promise<void> = Promise.resolve()
  private ignoreVaultEvent = false
  private readonly startSupervisedConnection: typeof startManagedConnection
  private readonly configurationPath: string
  private readonly openTextFile: (path: string, signal: AbortSignal) => Promise<void>
  private configurationText: string | undefined

  /**
   * @param ctx - Host context carrying credential storage and the tool registry when composed.
   * @param internals - replaceable connection factory for direct Host tests.
   */
  constructor(ctx: Context, internals: McpManagerControllerInternals = {}) {
    super(ctx, 'mcpManagerController', { namespace: 'mcpManager' })
    this.startSupervisedConnection = internals.startConnection ?? startManagedConnection
    const home = process.env.DSH_HOME
    this.configurationPath = internals.configurationPath
      ?? (home === undefined ? '' : join(home, 'mcp-servers.json'))
    this.openTextFile = internals.openTextFile ?? openNativeTextFile
    ctx.inject(['credentials', 'tools'], (runtimeContext) => {
      runtimeContext.effect(async () => {
        this.runtimeContext = runtimeContext
        await this.serial(async () => {
          const synchronized = await this.readSynchronizedVault()
          await this.reconcile(synchronized.vault)
        })
        const stop = runtimeContext.on('credentials/record-updated', (key) => {
          if (key !== VAULT_KEY || this.ignoreVaultEvent) return
          void this.serial(async () => {
            const vault = await this.readVault()
            await this.writeConfiguration(vault)
            await this.reconcile(vault)
          })
        })
        return async () => {
          stop()
          this.runtimeContext = undefined
          await this.disposeAll()
        }
      }, 'mcp-manager: protected registry lifecycle')
    })
  }

  /**
   * Return every saved server without authentication values.
   * @returns redacted registry state and live connection snapshots.
   */
  @Remote
  describe(): Promise<McpManagerState> {
    return this.serial(async () => this.publicState(await this.synchronizedVault()))
  }

  /**
   * Materialize and open the dedicated MCP registry document.
   * @param signal - caller lifetime; abort terminates the native open command.
   * @returns confirmation after the operating system accepts the document.
   */
  @Remote
  openConfigurationFile(signal: AbortSignal): Promise<SettingsDocumentOpenValue> {
    return this.serial(async () => {
      throwIfOpenAborted(signal)
      const vault = await this.synchronizedVault()
      await this.writeConfiguration(vault)
      try {
        await this.openTextFile(this.requiredConfigurationPath(), signal)
      } catch (error: unknown) {
        throwIfOpenAborted(signal)
        throw new RemoteError('gateway/internal', `MCP configuration open failed: ${messageOf(error)}`, {}, { cause: error })
      }
      return { opened: true }
    })
  }

  /**
   * Add or replace one protected server profile and reconcile its connection.
   * @param input - complete staged profile; omitted secret fields retain saved values on edit.
   * @returns redacted registry state after reconciliation.
   */
  @Remote
  save(input: McpServerInput): Promise<McpManagerState> {
    return this.serial(async () => {
      const credentials = this.credentials()
      const vault = await this.synchronizedVault()
      const existing = input.id === undefined ? undefined : vault.servers.find(server => server.id === input.id)
      if (input.id !== undefined && existing === undefined) throw notFound(input.id)
      if (existing === undefined && vault.servers.length >= MAX_SERVERS) {
        throw rejected(undefined, `at most ${MAX_SERVERS} MCP servers can be saved`)
      }
      const saved = validateInput(input, existing)
      const duplicate = vault.servers.find(server => server.serverName === saved.serverName && server.id !== saved.id)
      if (duplicate !== undefined) {
        throw rejected(saved.id, `tool namespace "${saved.serverName}" is already used by ${duplicate.name}`)
      }
      const servers = existing === undefined
        ? [...vault.servers, saved]
        : vault.servers.map(server => server.id === saved.id ? saved : server)
      const next: McpVault = { version: 1, servers }
      await this.writeVault(credentials, next)
      await this.writeConfiguration(next)
      await this.reconcile(next)
      return this.publicState(next)
    })
  }

  /**
   * Enable or disable one saved server. Disabled servers publish no tools.
   * @param serverId - stable identifier returned by {@link describe}.
   * @param enabled - whether Harnessy should supervise the connection.
   * @returns redacted registry state after reconciliation.
   */
  @Remote
  setEnabled(serverId: string, enabled: boolean): Promise<McpManagerState> {
    return this.serial(async () => {
      const credentials = this.credentials()
      const vault = await this.synchronizedVault()
      const current = vault.servers.find(server => server.id === serverId)
      if (current === undefined) throw notFound(serverId)
      const next: McpVault = {
        version: 1,
        servers: vault.servers.map(server => server.id === serverId
          ? { ...server, enabled, updatedAt: Math.max(Date.now(), server.updatedAt + 1) }
          : server),
      }
      await this.writeVault(credentials, next)
      await this.writeConfiguration(next)
      await this.reconcile(next)
      return this.publicState(next)
    })
  }

  /**
   * Restart an enabled server immediately and wait for its first connection attempt.
   * @param serverId - stable identifier returned by {@link describe}.
   * @returns redacted registry state after the attempt settles.
   */
  @Remote
  reconnect(serverId: string): Promise<McpManagerState> {
    return this.serial(async () => {
      const vault = await this.synchronizedVault()
      const server = vault.servers.find(candidate => candidate.id === serverId)
      if (server === undefined) throw notFound(serverId)
      if (!server.enabled) throw rejected(serverId, 'enable the server before testing its connection')
      await this.stop(serverId)
      const entry = this.start(server)
      if (entry !== undefined) await entry.handle.ready
      return this.publicState(vault)
    })
  }

  /**
   * Remove one saved server and unregister all tools it owns.
   * @param serverId - stable identifier returned by {@link describe}.
   * @returns redacted registry state after removal.
   */
  @Remote
  deleteServer(serverId: string): Promise<McpManagerState> {
    return this.serial(async () => {
      const credentials = this.credentials()
      const vault = await this.synchronizedVault()
      if (!vault.servers.some(server => server.id === serverId)) throw notFound(serverId)
      const next: McpVault = {
        version: 1,
        servers: vault.servers.filter(server => server.id !== serverId),
      }
      await this.writeVault(credentials, next)
      await this.writeConfiguration(next)
      await this.reconcile(next)
      return this.publicState(next)
    })
  }

  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.queue.then(operation, operation)
    this.queue = next.then(() => undefined, () => undefined)
    return next
  }

  private async reconcile(vault: McpVault): Promise<void> {
    const desired = new Map(vault.servers.filter(server => server.enabled).map(server => [server.id, server]))
    for (const serverId of [...this.runtime.keys()]) {
      const server = desired.get(serverId)
      if (server === undefined) {
        await this.stop(serverId)
        continue
      }
      if (this.runtime.get(serverId)?.profileKey === profileKey(server)) continue
      await this.stop(serverId)
    }
    for (const server of desired.values()) {
      if (!this.runtime.has(server.id)) this.start(server)
    }
    const known = new Set(vault.servers.map(server => server.id))
    for (const serverId of [...this.status.keys()]) {
      if (!known.has(serverId)) this.status.delete(serverId)
    }
  }

  private start(server: StoredServer): RuntimeEntry | undefined {
    const runtimeContext = this.runtimeContext
    if (runtimeContext === undefined) return undefined
    const token = Symbol(server.id)
    this.status.set(server.id, { status: 'connecting', tools: [] })
    try {
      const handle = this.startSupervisedConnection(
        runtimeContext,
        clientConfig(server),
        resolveReconnectPolicy(undefined, `mcp-manager(${server.serverName}): reconnect`),
        (snapshot) => {
          if (this.runtime.get(server.id)?.token !== token) return
          this.status.set(server.id, snapshot)
        },
      )
      const entry = { token, profileKey: profileKey(server), handle }
      this.runtime.set(server.id, entry)
      return entry
    } catch (error) {
      this.status.set(server.id, { status: 'error', tools: [], error: messageOf(error) })
      return undefined
    }
  }

  private async stop(serverId: string): Promise<void> {
    const entry = this.runtime.get(serverId)
    this.runtime.delete(serverId)
    this.status.delete(serverId)
    if (entry !== undefined) await entry.handle.dispose()
  }

  private async disposeAll(): Promise<void> {
    const entries = [...this.runtime.values()]
    this.runtime.clear()
    this.status.clear()
    await Promise.all(entries.map(entry => entry.handle.dispose()))
  }

  private async readVault(): Promise<McpVault> {
    const credentials = this.ctx.get('credentials')
    if (credentials === undefined) return { version: 1, servers: [] }
    return parseVault(await credentials.readRecord(VAULT_KEY))
  }

  private requiredConfigurationPath(): string {
    if (this.configurationPath === '') {
      throw unavailable('DSH_HOME is unavailable, so the MCP configuration file has no durable location')
    }
    return this.configurationPath
  }

  private async synchronizedVault(): Promise<McpVault> {
    const synchronized = await this.readSynchronizedVault()
    if (synchronized.imported) await this.reconcile(synchronized.vault)
    return synchronized.vault
  }

  private async readSynchronizedVault(): Promise<SynchronizedVault> {
    const vault = await this.readVault()
    const path = this.requiredConfigurationPath()
    let text: string
    try {
      text = await readFile(path, 'utf8')
    } catch (error: unknown) {
      if (!isMissingFile(error)) throw error
      await this.writeConfiguration(vault)
      return { vault, imported: false }
    }
    if (text === this.configurationText) return { vault, imported: false }
    const imported = parseConfigurationText(text)
    this.configurationText = text
    if (profileKeyOfVault(imported) === profileKeyOfVault(vault)) return { vault, imported: false }
    await this.writeVault(this.credentials(), imported)
    return { vault: imported, imported: true }
  }

  private async writeConfiguration(vault: McpVault): Promise<void> {
    const path = this.requiredConfigurationPath()
    const text = `${JSON.stringify(vault, null, 2)}\n`
    await writeFile(path, text, { encoding: 'utf8', mode: 0o600 })
    this.configurationText = text
  }

  private async writeVault(credentials: CredentialProvider, vault: McpVault): Promise<void> {
    this.ignoreVaultEvent = true
    try {
      await credentials.modifyRecord(VAULT_KEY, () => Promise.resolve({
        kind: 'grant',
        payload: JSON.parse(JSON.stringify(vault)) as unknown,
      }))
    } finally {
      this.ignoreVaultEvent = false
    }
  }

  private async publicState(vault: McpVault): Promise<McpManagerState> {
    const credentials = this.ctx.get('credentials')
    const available = credentials !== undefined && this.ctx.get('tools') !== undefined
    const writable = credentials === undefined ? false : (await credentials.describeRecord(VAULT_KEY)).writable
    return {
      available,
      writable,
      servers: vault.servers.map(server => publicServer(server, this.status.get(server.id))),
    }
  }

  private credentials(): CredentialProvider {
    const credentials = this.ctx.get('credentials')
    if (credentials === undefined) throw unavailable('protected credential storage is not mounted')
    return credentials
  }
}

function validateInput(input: McpServerInput, existing: StoredServer | undefined): StoredServer {
  const id = existing?.id ?? `mcp_${randomUUID().replaceAll('-', '')}`
  const name = bounded(input.name, 80, 'server name')
  const serverName = bounded(input.serverName, 32, 'tool namespace')
  if (!SERVER_NAME.test(serverName)) {
    throw rejected(id, 'tool namespace must use 1–32 letters, numbers, underscores, or hyphens')
  }
  const base = {
    id, name, serverName, enabled: input.enabled,
    updatedAt: Math.max(Date.now(), (existing?.updatedAt ?? 0) + 1),
  }
  switch (input.transport) {
    case 'streamable-http': {
      const url = secureMcpUrl(bounded(input.url ?? '', 2_048, 'server URL'), id)
      const headerName = bounded(input.headerName ?? 'Authorization', 128, 'authentication header')
      if (!HEADER_NAME.test(headerName)) throw rejected(id, 'authentication header contains invalid characters')
      const authorization = input.clearAuthentication === true
        ? undefined
        : optionalSecret(input.authorization) ?? (existing?.transport === 'streamable-http' ? existing.authorization : undefined)
      return { ...base, transport: input.transport, url, headerName, ...authorization === undefined ? {} : { authorization } }
    }
    case 'stdio': {
      const command = bounded(input.command ?? '', 1_024, 'command')
      const args = [...(input.args ?? [])]
      if (args.length > 64 || args.some(arg => typeof arg !== 'string' || arg.length > 2_048)) {
        throw rejected(id, 'command arguments must contain at most 64 entries of 2,048 characters')
      }
      const cwd = input.cwd === undefined || input.cwd.trim() === '' ? '' : bounded(input.cwd, 2_048, 'working directory')
      const environment = input.clearAuthentication === true
        ? {}
        : input.environment === undefined
          ? existing?.transport === 'stdio' ? existing.environment : {}
          : validateEnvironment(input.environment, id)
      return { ...base, transport: input.transport, command, args, cwd, environment }
    }
  }
}

function validateEnvironment(value: Readonly<Record<string, string>>, serverId: string): Readonly<Record<string, string>> {
  const entries = Object.entries(value)
  if (entries.length > 64) throw rejected(serverId, 'environment can contain at most 64 values')
  for (const [key, secret] of entries) {
    if (!ENV_NAME.test(key)) throw rejected(serverId, `environment name "${key}" is invalid`)
    if (secret.length === 0 || secret.length > MAX_SECRET_LENGTH) {
      throw rejected(serverId, `environment value "${key}" must contain 1–${MAX_SECRET_LENGTH} characters`)
    }
  }
  return Object.fromEntries(entries)
}

function optionalSecret(value: string | undefined): string | undefined {
  if (value === undefined || value.length === 0) return undefined
  if (value.length > MAX_SECRET_LENGTH) throw rejected(undefined, `authentication can contain at most ${MAX_SECRET_LENGTH} characters`)
  return value
}

function secureMcpUrl(value: string, serverId: string): string {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw rejected(serverId, 'server URL is invalid')
  }
  const localHttp = url.protocol === 'http:' && ['127.0.0.1', 'localhost', '::1'].includes(url.hostname)
  if (url.protocol !== 'https:' && !localHttp) {
    throw rejected(serverId, 'remote MCP servers must use HTTPS; HTTP is allowed only on this computer')
  }
  if (url.username !== '' || url.password !== '' || url.hash !== '') {
    throw rejected(serverId, 'server URL cannot contain credentials or a fragment')
  }
  return url.href
}

function bounded(value: string, max: number, label: string): string {
  const normalized = value.trim()
  if (normalized.length === 0 || normalized.length > max) {
    throw rejected(undefined, `${label} must contain 1–${max} characters`)
  }
  return normalized
}

function parseVault(record: CredentialRecord | undefined): McpVault {
  if (record?.kind !== 'grant' || !isRecord(record.payload)) return { version: 1, servers: [] }
  const payload = record.payload
  if (payload.version !== 1 || !Array.isArray(payload.servers)) return { version: 1, servers: [] }
  const servers = payload.servers.filter(isStoredServer)
  return { version: 1, servers }
}

function parseConfigurationText(text: string): McpVault {
  let value: unknown
  try {
    value = JSON.parse(text) as unknown
  } catch (error: unknown) {
    throw rejected(undefined, `MCP configuration is not valid JSON: ${messageOf(error)}`)
  }
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.servers)) {
    throw rejected(undefined, 'MCP configuration must contain version 1 and a servers array')
  }
  if (value.servers.length > MAX_SERVERS || !value.servers.every(isStoredServer)) {
    throw rejected(undefined, `MCP configuration must contain at most ${MAX_SERVERS} complete server entries`)
  }
  const ids = new Set<string>()
  const namespaces = new Set<string>()
  for (const server of value.servers) {
    if (server.id.length === 0 || server.id.length > 128 || ids.has(server.id)) {
      throw rejected(server.id, 'MCP server ids must be unique and contain 1–128 characters')
    }
    ids.add(server.id)
    bounded(server.name, 80, 'server name')
    if (!SERVER_NAME.test(server.serverName) || namespaces.has(server.serverName)) {
      throw rejected(server.id, 'tool namespaces must be unique and use 1–32 letters, numbers, underscores, or hyphens')
    }
    namespaces.add(server.serverName)
    if (!Number.isFinite(server.updatedAt)) throw rejected(server.id, 'updatedAt must be a finite number')
    if (server.transport === 'streamable-http') {
      secureMcpUrl(server.url, server.id)
      if (!HEADER_NAME.test(server.headerName)) throw rejected(server.id, 'authentication header contains invalid characters')
      optionalSecret(server.authorization)
    } else {
      bounded(server.command, 1_024, 'command')
      if (server.args.length > 64 || server.args.some(arg => arg.length > 2_048)) {
        throw rejected(server.id, 'command arguments must contain at most 64 entries of 2,048 characters')
      }
      if (server.cwd.length > 2_048) throw rejected(server.id, 'working directory can contain at most 2,048 characters')
      validateEnvironment(server.environment, server.id)
    }
  }
  return { version: 1, servers: value.servers }
}

function profileKeyOfVault(vault: McpVault): string {
  return JSON.stringify(vault)
}

function isMissingFile(error: unknown): boolean {
  return typeof error === 'object' && error !== null && Reflect.get(error, 'code') === 'ENOENT'
}

function throwIfOpenAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new RemoteError('gateway/cancelled', 'MCP configuration open was aborted', {})
}

function isStoredServer(value: unknown): value is StoredServer {
  if (!isRecord(value) || typeof value.id !== 'string' || typeof value.name !== 'string'
    || typeof value.serverName !== 'string' || typeof value.enabled !== 'boolean'
    || typeof value.updatedAt !== 'number') return false
  if (value.transport === 'streamable-http') {
    return typeof value.url === 'string' && typeof value.headerName === 'string'
      && (value.authorization === undefined || typeof value.authorization === 'string')
  }
  return value.transport === 'stdio' && typeof value.command === 'string' && Array.isArray(value.args)
    && value.args.every(arg => typeof arg === 'string') && typeof value.cwd === 'string'
    && isStringRecord(value.environment)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every(item => typeof item === 'string')
}

function clientConfig(server: StoredServer): McpClientConfig {
  const common = {
    serverName: server.serverName,
    toolCallTimeoutMs: 60_000,
    failOnStartupError: true,
  }
  if (server.transport === 'streamable-http') {
    return {
      ...common,
      transport: server.transport,
      url: server.url,
      headers: server.authorization === undefined ? {} : { [server.headerName]: server.authorization },
    }
  }
  return {
    ...common,
    transport: server.transport,
    command: server.command,
    args: [...server.args],
    env: { ...server.environment },
    cwd: server.cwd,
  }
}

/** Stable in-memory reconciliation key; this value never crosses the Remote boundary. */
function profileKey(server: StoredServer): string {
  return JSON.stringify(server)
}

function publicServer(server: StoredServer, live: ConnectionSnapshot | undefined): McpServerView {
  const status: McpServerStatus = server.enabled ? live?.status ?? 'connecting' : 'disabled'
  const prefix = `mcp__${server.serverName}__`
  return {
    id: server.id,
    name: server.name,
    serverName: server.serverName,
    transport: server.transport,
    enabled: server.enabled,
    endpoint: server.transport === 'streamable-http' ? server.url : server.command,
    ...server.transport === 'streamable-http' ? { headerName: server.headerName } : {},
    args: server.transport === 'stdio' ? [...server.args] : [],
    ...server.transport === 'stdio' && server.cwd !== '' ? { cwd: server.cwd } : {},
    status,
    tools: live?.tools.map(tool => tool.startsWith(prefix) ? tool.slice(prefix.length) : tool) ?? [],
    ...live?.error === undefined ? {} : { error: safeConnectionError(server, live.error) },
    authenticationConfigured: server.transport === 'streamable-http'
      ? server.authorization !== undefined
      : Object.keys(server.environment).length > 0,
    environmentKeys: server.transport === 'stdio' ? Object.keys(server.environment).sort() : [],
    updatedAt: server.updatedAt,
  }
}

function unavailable(message: string): RemoteError {
  return new RemoteError('mcp-manager/unavailable', message, {})
}

function rejected(serverId: string | undefined, message: string): RemoteError {
  return new RemoteError('mcp-manager/rejected', message, serverId === undefined ? {} : { serverId })
}

function notFound(serverId: string): RemoteError {
  return new RemoteError('mcp-manager/not-found', 'the requested MCP server was not found', { serverId })
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Map transport diagnostics to useful client copy without exposing URLs or credentials. */
function safeConnectionError(server: StoredServer, error: string): string {
  const normalized = error.toLowerCase()
  if (normalized.includes('already in use') || normalized.includes('conflict') || normalized.includes('register')) {
    return 'A tool name or namespace conflicts with another active MCP server.'
  }
  if (server.transport === 'stdio'
    && (normalized.includes('enoent') || normalized.includes('not found') || normalized.includes('spawn'))) {
    return 'The local MCP command could not be started.'
  }
  if (normalized.includes('timeout') || normalized.includes('timed out')) {
    return 'The MCP server did not respond in time.'
  }
  return 'Harnessy could not connect to this MCP server. Check its connection settings.'
}

export default McpManagerController
