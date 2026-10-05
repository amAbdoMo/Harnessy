/** Relationship-preserving identity redaction for committed session snapshots. */

const UUID_FRAGMENT_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i
const LEGACY_TOKEN_RE = /^\{\{(?:sessionId|messageId)\}\}$/
const CANONICAL_TOKEN_RE = /^\{\{(session|message|approval|workflow|command|rpc|retry|id):([1-9]\d*)\}\}$/
const ID_KEY_RE = /(?:^id$|Id$|Ids$)/

type IdentityKind = 'session' | 'message' | 'approval' | 'workflow' | 'command' | 'rpc' | 'retry' | 'id'

interface ParsedLog {
  readonly records: Record<string, unknown>[]
  readonly trailingNewline: boolean
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function parseLog(log: string): ParsedLog {
  return {
    records: log.split(/\r?\n/)
      .filter(line => line.trim() !== '')
      .map(line => JSON.parse(line) as Record<string, unknown>),
    trailingNewline: log.endsWith('\n'),
  }
}

function messageId(value: unknown): string | undefined {
  if (!isRecord(value)
    || typeof value.id !== 'string'
    || typeof value.role !== 'string'
    || !Array.isArray(value.content)
    || !isRecord(value.source)) return undefined
  return value.id
}

function websitePreparationRequestId(text: string): string | undefined {
  const suffix = '\nWaiting for the human to Resume this request. No page access is granted.'
  if (!text.endsWith(suffix)) return undefined
  let value: unknown
  try { value = JSON.parse(text.slice(0, -suffix.length)) }
  catch (_error) { // Non-JSON tool text is not a preparation receipt.
    return undefined
  }
  if (!isRecord(value) || Object.keys(value).length !== 4
    || typeof value.requestId !== 'string' || typeof value.profileId !== 'string'
    || typeof value.mcpServerName !== 'string' || value.status !== 'pending') return undefined
  if (UUID_FRAGMENT_RE.exec(value.requestId)?.[0] !== value.requestId
    && !CANONICAL_TOKEN_RE.test(value.requestId)) return undefined
  return value.requestId
}

function websitePreparationIds(record: Record<string, unknown>, callIds: ReadonlySet<string>): string[] {
  if (record.type !== 'tool/result' || !isRecord(record.data)
    || !isRecord(record.data.message)) return []
  const message = record.data.message
  if (!Array.isArray(message.content) || message.role !== 'tool' || message.isError !== false
    || typeof message.toolCallId !== 'string' || !callIds.has(message.toolCallId)) return []
  const ids: string[] = []
  for (const part of message.content) {
    if (!isRecord(part) || part.type !== 'text' || typeof part.text !== 'string') continue
    const id = websitePreparationRequestId(part.text)
    if (id !== undefined) ids.push(id)
  }
  return ids
}

function redactedCandidate(value: string): boolean {
  return UUID_FRAGMENT_RE.test(value) || LEGACY_TOKEN_RE.test(value) || CANONICAL_TOKEN_RE.test(value)
}

/**
 * Replace volatile opaque ids while preserving equality relationships across a parent and its child logs.
 * @param logs - one scenario's primary-first session JSONL fixtures.
 * @returns compact JSONL with typed first-seen identity tokens.
 */
export function redactSessionSnapshotIds(logs: readonly string[]): string[] {
  const parsed = logs.map(parseLog)
  const tokenByValue = new Map<string, string>()
  const nextByKind = new Map<IdentityKind, number>()

  const claim = (value: unknown, kind: IdentityKind, always = false): void => {
    if (typeof value !== 'string' || value.length === 0 || tokenByValue.has(value)) return
    if (!always && !redactedCandidate(value)) return
    const canonical = CANONICAL_TOKEN_RE.exec(value)
    if (canonical !== null) {
      const canonicalKind = canonical[1] as IdentityKind
      const ordinal = Number(canonical[2])
      nextByKind.set(canonicalKind, Math.max(nextByKind.get(canonicalKind) ?? 0, ordinal))
      tokenByValue.set(value, value)
      return
    }
    const next = (nextByKind.get(kind) ?? 0) + 1
    nextByKind.set(kind, next)
    tokenByValue.set(value, `{{${kind}:${next}}}`)
  }

  for (const log of parsed) {
    const header = log.records[0]
    if (header?.type === 'session') claim(header.id, 'session', true)
  }

  const collect = (value: unknown, recordType?: unknown): void => {
    if (typeof value === 'string') {
      for (const match of value.matchAll(/\bas message ([0-9a-f-]{36})\b/gi)) claim(match[1], 'message')
      for (const match of value.matchAll(/\bAnonymous user: ([0-9a-f-]{36})\b/gi)) claim(match[1], 'id')
      return
    }
    if (Array.isArray(value)) {
      for (const item of value) collect(item, recordType)
      return
    }
    if (!isRecord(value)) return

    const identifiedMessage = messageId(value)
    if (identifiedMessage !== undefined) claim(identifiedMessage, 'message')
    for (const [childKey, item] of Object.entries(value)) {
      if (recordType === 'approval/asked' || recordType === 'approval/decided') {
        if (childKey === 'id') claim(item, 'approval')
      } else if (childKey === 'commandId') {
        claim(item, 'command', true)
      } else if (childKey === 'rpcId') {
        claim(item, 'rpc', true)
      } else if (childKey === 'retryId') {
        claim(item, 'retry')
      } else if (childKey === 'runId') {
        claim(item, 'workflow')
      } else if (ID_KEY_RE.test(childKey)) {
        claim(item, 'id')
      }
      collect(item, recordType)
    }
  }
  for (const log of parsed) {
    const preparationCallIds = new Set<string>()
    for (const record of log.records) {
      if (record.type === 'tool/call' && isRecord(record.data)
        && record.data.name === 'website_prepare' && typeof record.data.callId === 'string') {
        preparationCallIds.add(record.data.callId)
      }
    }
    for (const record of log.records) {
      for (const id of websitePreparationIds(record, preparationCallIds)) claim(id, 'id')
      if (record.type === 'feedback/message-put' && isRecord(record.data) && isRecord(record.data.item)) {
        claim(record.data.item.version, 'id')
      }
      collect(record, record.type)
    }
  }

  const replacements = [...tokenByValue]
    .sort(([left], [right]) => right.length - left.length)
  const replace = (value: unknown): unknown => {
    if (typeof value === 'string') {
      const exact = tokenByValue.get(value)
      if (exact !== undefined) return exact
      let output = value
      for (const [source, token] of replacements) output = output.split(source).join(token)
      return output
    }
    if (Array.isArray(value)) return value.map(replace)
    if (isRecord(value)) {
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, replace(item)]))
    }
    return value
  }

  return parsed.map((log) => {
    const content = log.records.map(record => JSON.stringify(replace(record))).join('\n')
    return log.trailingNewline ? `${content}\n` : content
  })
}
