/** Safe tool text over real accepted Session events; no raw presenter, credential, filesystem or model I/O. */
import { describe, expect, it } from 'vitest'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { ToolCallId } from '@deepseek-ai/dsh-llm/brand'
import { createToolResultMessage } from '@deepseek-ai/dsh-llm'
import { parseApplicationBudget } from '@deepseek-ai/dsh-companion-protocol'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { mobileToolResultText, observedToolCall } from '../src/tool-activity.ts'
import { mobileHistoryPage } from '../src/session-view.ts'

const budget = parseApplicationBudget({ maxRequestBytes: 4096, maxResultBytes: 4096, maxTextBytes: 1024,
  maxTitleBytes: 128, maxRows: 10, maxSessions: 10, maxSubscriptionsPerGrant: 2, maxPendingSubmissionsPerGrant: 2,
  readTimeoutMs: 10000, subscriptionLifetimeMs: 60000 })
const cwd = 'C:\\workspace'
const secret = 'PRIVATE-CONTENT-COMMAND-ARGUMENT-DIFF-ERROR'
function fixture(name = 'read', meta: JsonValue = readMetadata(), failed = false) {
  const session = Session.create(SessionId('phone-tool-projection'))
  const callId = ToolCallId('fixture-call')
  const call = session.append('tool/call', { turn: 1, step: 1, callId, name, arguments: secret })
  const result = session.append('tool/result', { turn: 1, step: 1, meta,
    message: createToolResultMessage({ callId, content: [{ type: 'text', text: secret }], isError: failed }),
    ...(failed ? { error: { name: 'PrivateFailure', code: 'private', reason: secret } } : {}),
  }, { surfaceOp: 'append', sourceEventSeqs: [call.seq] })
  const events = [call, result]
  return { call, result, events, context: { cwd, budget, callAt: (seq: typeof call.seq) => observedToolCall(events, seq) } }
}
function readMetadata(path = 'C:\\workspace\\src\\例.ts'): JsonValue {
  return { path, offset: 2, lines: [{ number: 2, text: secret }, { number: 3, text: secret }], totalLines: 8 }
}

describe('opt-in phone tool text', () => {
  it('shows relative target and actual read window without arguments, contents or diagnostics', () => {
    const value = fixture()
    const text = mobileToolResultText(value.result, value.context)
    expect(text).toBe('read — completed\nsrc/例.ts\nReturned 2 lines from 2; total 8')
    expect(text).not.toContain(secret)
    expect(text).not.toContain('C:')
  })

  it.each([
    ['write', { path: 'src/new.ts', operation: 'create', diffs: [secret] }, 'src/new.ts\nCreated'],
    ['write', { path: 'src/old.ts', operation: 'update', diffs: [secret] }, 'src/old.ts\nUpdated'],
    ['edit', { path: 'src/old.ts', diffs: [secret] }, 'src/old.ts'],
    ['grep', { shape: 'matches', total: 17, truncated: true, files: [secret] }, 'Matched lines: 17\nPartial results'],
    ['glob', { shape: 'paths', total: 9, truncated: false, paths: [secret] }, 'Discovered paths: 9'],
  ] satisfies [string, JsonValue, string][])('projects only approved %s result fields', (name, meta, detail) => {
    const value = fixture(name, meta)
    const text = mobileToolResultText(value.result, value.context)
    expect(text).toBe(`${name} — completed\n${detail}`)
    expect(text).not.toContain(secret)
  })

  it.each(['C:\\outside\\secret.txt', 'C:secret.txt', '..\\secret.txt', 'https://secret.invalid/key',
    '\\\\host\\share\\secret.txt', '\\\\?\\C:\\workspace\\secret.txt', 'src/line\nbreak.ts', 'src/\u202esecret.ts', 'src/\ud800.ts']) (
    'omits unsafe target %j rather than publishing a substituted path', (path) => {
      const value = fixture('read', readMetadata(path))
      expect(mobileToolResultText(value.result, value.context)).toBe('read — completed')
    },
  )

  it.each([
    { path: 'src/a', offset: 0, lines: [], totalLines: 1 },
    { path: 'src/a', offset: 2, lines: [{ number: 7, text: secret }], totalLines: 9 },
    { path: 'src/a', offset: 2, lines: [{ number: 2, text: secret }], totalLines: 0 },
    { shape: 'matches', total: -1, truncated: false },
  ] satisfies JsonValue[])('falls back to fixed status for malformed owned metadata', (meta) => {
    const value = fixture('read', meta)
    expect(mobileToolResultText(value.result, value.context)).toBe('read — completed')
  })

  it('uses fixed failure status and ignores metadata from unsupported tools', () => {
    const failed = fixture('read', readMetadata(), true)
    expect(mobileToolResultText(failed.result, failed.context)).toBe('read — failed')
    const shell = fixture('pwsh', { title: secret, command: secret, path: 'src/secret' })
    expect(mobileToolResultText(shell.result, shell.context)).toBe('pwsh — completed')
  })

  it('refuses missing and mismatched call identity instead of borrowing a nearby tool', () => {
    const value = fixture()
    expect(mobileToolResultText({ ...value.result, sourceEventSeqs: [] }, value.context)).toBeUndefined()
    expect(mobileToolResultText({ ...value.result, data: { ...value.result.data, turn: 2 } }, value.context)).toBeUndefined()
    expect(mobileToolResultText(value.result, { ...value.context, callAt: () => undefined })).toBeUndefined()
    expect(mobileToolResultText(value.result, { ...value.context, callAt: () => ({ ...value.call.data,
      seq: value.call.seq, callId: ToolCallId('different-call') }) })).toBeUndefined()
  })

  it('keeps call-before-page detail correlation and does not skip a full page boundary', () => {
    const value = fixture()
    const options = { offset: 0, through: value.events.length, limit: 1, budget, requireCurrent: () => {},
      toolDetails: { cwd, requireCurrent: () => {} } }
    const first = mobileHistoryPage(value.events, options)
    expect(first.rows.map(row => row.id)).toEqual([`event-${value.call.seq}`])
    const next = mobileHistoryPage(value.events, { ...options, offset: first.nextOffset })
    expect(next.rows[0]?.text).toContain('src/例.ts')
    expect(next.nextOffset).toBe(value.events.length)
    expect(mobileHistoryPage(value.events, { offset: 0, through: value.events.length, limit: 1, budget,
      requireCurrent: () => {} }).rows).toEqual([])
  })

  it('applies the complete UTF-8 text budget and drops optional details before fixed status', () => {
    const value = fixture()
    const text = mobileToolResultText(value.result, value.context)
    expect(text).toBeDefined()
    const bytes = Buffer.byteLength(text ?? '', 'utf8')
    expect(mobileToolResultText(value.result, { ...value.context, budget: { ...budget, maxTextBytes: bytes } })).toBe(text)
    expect(mobileToolResultText(value.result, { ...value.context, budget: { ...budget, maxTextBytes: bytes - 1 } })).toBe('read — completed')
    expect(mobileToolResultText(value.result, { ...value.context, budget: { ...budget, maxTextBytes: 1 } })).toBeUndefined()
  })
})
