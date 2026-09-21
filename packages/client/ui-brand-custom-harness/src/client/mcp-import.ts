/** Provider-tolerant import of JSON MCP server configurations. */

import type { McpServerInput } from '@deepseek-ai/dsh-api-remotes/client'

const MAX_NAMESPACE_LENGTH = 32

/** One import preview row; secrets remain only inside the staged input. */
export interface ImportedMcpServer {
  /** Source key from the imported provider configuration. */
  readonly sourceName: string
  /** Complete input staged for protected storage. */
  readonly input: McpServerInput
  /** Number of protected environment or header values carried by the input. */
  readonly protectedValueCount: number
}

/** Result of parsing one provider JSON file. */
export interface McpJsonImport {
  /** Server profiles that can be saved. */
  readonly servers: readonly ImportedMcpServer[]
  /** Entry names that did not describe a supported local or HTTP server. */
  readonly skippedNames: readonly string[]
  /** Number of per-server timeout values omitted because Harnessy has no matching setting. */
  readonly ignoredTimeoutCount: number
  /** Number of extra remote headers omitted after the first authentication header. */
  readonly ignoredHeaderCount: number
  /** Entries omitted because protected storage has no remaining server slots. */
  readonly capacitySkippedCount: number
}

type JsonRecord = Record<string, unknown>

interface ParsedServerEntry {
  readonly server: ImportedMcpServer
  readonly ignoredHeaders: number
}

interface ImportAccumulator {
  readonly capacity: number
  readonly usedNamespaces: Set<string>
  readonly servers: ImportedMcpServer[]
  readonly skippedNames: string[]
  ignoredTimeoutCount: number
  ignoredHeaderCount: number
  capacitySkippedCount: number
}

function recordOf(candidate: unknown): JsonRecord | undefined {
  return typeof candidate === 'object' && candidate !== null && !Array.isArray(candidate)
    ? candidate as JsonRecord
    : undefined
}

function stringOf(candidate: unknown): string | undefined {
  return typeof candidate === 'string' && candidate.trim().length > 0 ? candidate.trim() : undefined
}

function secretStringOf(candidate: unknown): string | undefined {
  return typeof candidate === 'string' && candidate.length > 0 ? candidate : undefined
}

function stringArrayOf(candidate: unknown): string[] {
  return Array.isArray(candidate)
    ? candidate.flatMap(entry => typeof entry === 'string' ? [entry] : [])
    : []
}

function environmentOf(candidate: unknown): Record<string, string> | undefined {
  const record = recordOf(candidate)
  if (record === undefined) return undefined
  const entries = Object.entries(record).flatMap(([key, entry]) => {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key)) return []
    if (!['string', 'number', 'boolean'].includes(typeof entry)) return []
    return [[key, String(entry)] as const]
  })
  return entries.length === 0 ? undefined : Object.fromEntries(entries)
}

function enabledOf(entry: JsonRecord): boolean {
  if (typeof entry.enabled === 'boolean') return entry.enabled
  if (typeof entry.disabled === 'boolean') return !entry.disabled
  return true
}

function namespaceBase(requested: string): string {
  const normalized = requested
    .normalize('NFKD')
    .replace(/[^A-Za-z0-9_-]+/gu, '_')
    .replace(/^[_-]+|[_-]+$/gu, '')
    .replace(/_{2,}/gu, '_')
    .toLowerCase()
  return (normalized.length === 0 ? 'mcp_server' : normalized).slice(0, MAX_NAMESPACE_LENGTH)
}

function uniqueNamespace(requested: string, used: Set<string>): string {
  const base = namespaceBase(requested)
  let candidate = base
  let suffix = 2
  while (used.has(candidate.toLowerCase())) {
    const ending = `_${String(suffix)}`
    candidate = `${base.slice(0, MAX_NAMESPACE_LENGTH - ending.length)}${ending}`
    suffix += 1
  }
  used.add(candidate.toLowerCase())
  return candidate
}

function serverEntries(root: JsonRecord): readonly [string, unknown][] | undefined {
  for (const key of ['mcpServers', 'mcp', 'servers'] as const) {
    const candidate = recordOf(root[key])
    if (candidate !== undefined) return Object.entries(candidate)
  }
  const direct = Object.entries(root)
  return direct.some(([, entry]) => recordOf(entry) !== undefined) ? direct : undefined
}

function localInput(
  sourceName: string,
  entry: JsonRecord,
  serverName: string,
): ImportedMcpServer | undefined {
  const commandArray = stringArrayOf(entry.command)
  const command = stringOf(entry.command) ?? commandArray[0]
  if (command === undefined) return undefined
  const args = commandArray.length > 0 ? [...commandArray.slice(1), ...stringArrayOf(entry.args)] : stringArrayOf(entry.args)
  const environment = environmentOf(entry.environment) ?? environmentOf(entry.env)
  const cwd = stringOf(entry.cwd) ?? stringOf(entry.workingDirectory) ?? ''
  const input: McpServerInput = {
    name: stringOf(entry.name) ?? sourceName,
    serverName,
    transport: 'stdio',
    enabled: enabledOf(entry),
    command,
    args,
    cwd,
    ...environment === undefined ? {} : { environment },
  }
  return {
    sourceName,
    input,
    protectedValueCount: Object.keys(environment ?? {}).length,
  }
}

function remoteInput(
  sourceName: string,
  entry: JsonRecord,
  serverName: string,
): { readonly server: ImportedMcpServer; readonly ignoredHeaders: number } | undefined {
  const type = stringOf(entry.type)?.toLowerCase()
  if (type === 'sse') return undefined
  const url = stringOf(entry.url) ?? stringOf(entry.endpoint)
  if (url === undefined) return undefined
  const headers = recordOf(entry.headers)
  const headerEntries = Object.entries(headers ?? {}).flatMap(([key, value]) => {
    const headerValue = secretStringOf(value)
    return headerValue === undefined ? [] : [[key, headerValue] as const]
  })
  const preferred = headerEntries.find(([key]) => key.toLowerCase() === 'authorization') ?? headerEntries[0]
  const input: McpServerInput = {
    name: stringOf(entry.name) ?? sourceName,
    serverName,
    transport: 'streamable-http',
    enabled: enabledOf(entry),
    url,
    ...preferred === undefined ? {} : { headerName: preferred[0], authorization: preferred[1] },
  }
  return {
    server: { sourceName, input, protectedValueCount: preferred === undefined ? 0 : 1 },
    ignoredHeaders: Math.max(0, headerEntries.length - (preferred === undefined ? 0 : 1)),
  }
}

function importedEntry(sourceName: string, entry: JsonRecord): ParsedServerEntry | undefined {
  const requestedNamespace = stringOf(entry.serverName) ?? sourceName
  const type = stringOf(entry.type)?.toLowerCase()
  const remote = stringOf(entry.url) !== undefined
    || stringOf(entry.endpoint) !== undefined
    || ['http', 'https', 'remote', 'streamable-http', 'sse'].includes(type ?? '')
  if (!remote) {
    const server = localInput(sourceName, entry, requestedNamespace)
    return server === undefined ? undefined : { server, ignoredHeaders: 0 }
  }
  return remoteInput(sourceName, entry, requestedNamespace)
}

function appendImportedEntry(accumulator: ImportAccumulator, sourceName: string, rawEntry: unknown): void {
  const entry = recordOf(rawEntry)
  if (entry === undefined) {
    accumulator.skippedNames.push(sourceName)
    return
  }
  if (entry.timeout !== undefined) accumulator.ignoredTimeoutCount += 1
  const imported = importedEntry(sourceName, entry)
  if (imported === undefined) {
    accumulator.skippedNames.push(sourceName)
    return
  }
  if (accumulator.servers.length >= accumulator.capacity) {
    accumulator.capacitySkippedCount += 1
    return
  }
  const serverName = uniqueNamespace(imported.server.input.serverName, accumulator.usedNamespaces)
  accumulator.servers.push({
    ...imported.server,
    input: { ...imported.server.input, serverName },
  })
  accumulator.ignoredHeaderCount += imported.ignoredHeaders
}

/**
 * Parse common MCP JSON formats without exposing staged secrets to the UI.
 *
 * Supported roots are OpenCode's `mcp`, Claude/Cursor/Gemini's `mcpServers`,
 * VS Code's `servers`, and a direct server map. Local `command` may be a string
 * plus `args` or an argv array. HTTP entries accept `url` or `endpoint`; SSE is
 * rejected because Harnessy cannot safely reinterpret that transport.
 *
 * @param text - complete JSON file contents.
 * @param existingNamespaces - namespaces already saved in protected storage.
 * @param capacity - number of additional server profiles storage can accept.
 * @returns staged server inputs and a redacted import summary.
 */
export function parseMcpJson(
  text: string,
  existingNamespaces: readonly string[] = [],
  capacity = 64,
): McpJsonImport {
  const parsed: unknown = JSON.parse(text)
  const root = recordOf(parsed)
  if (root === undefined) throw new Error('invalid-root')
  const entries = serverEntries(root)
  if (entries === undefined) throw new Error('missing-server-map')

  const accumulator: ImportAccumulator = {
    capacity: Math.max(0, capacity),
    usedNamespaces: new Set(existingNamespaces.map(namespace => namespace.toLowerCase())),
    servers: [],
    skippedNames: [],
    ignoredTimeoutCount: 0,
    ignoredHeaderCount: 0,
    capacitySkippedCount: 0,
  }
  for (const [sourceName, rawEntry] of entries) {
    appendImportedEntry(accumulator, sourceName, rawEntry)
  }
  return {
    servers: accumulator.servers,
    skippedNames: accumulator.skippedNames,
    ignoredTimeoutCount: accumulator.ignoredTimeoutCount,
    ignoredHeaderCount: accumulator.ignoredHeaderCount,
    capacitySkippedCount: accumulator.capacitySkippedCount,
  }
}
