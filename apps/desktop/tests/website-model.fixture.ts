/** Owned Messages-SSE provider for the real Native Website Agent scenario; no external API or credential is used. */
import { createServer, type ServerResponse } from 'node:http'

const marker = 'NATIVE_WEBSITE_AGENT_ACCEPTANCE'
type Phase = 'prepared' | 'observed' | 'taken-over'

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function blocks(body: Record<string, unknown>): Record<string, unknown>[] {
  const messages: readonly unknown[] = Array.isArray(body.messages) ? body.messages : []
  return messages.flatMap((message) => {
    if (!object(message) || !Array.isArray(message.content)) return []
    const content: readonly unknown[] = message.content
    return content.filter(object)
  })
}

function result(body: Record<string, unknown>, id: string): Record<string, unknown> | undefined {
  return blocks(body).find(block => block.type === 'tool_result' && block.tool_use_id === id)
}

function value(block: Record<string, unknown>): unknown {
  const content: readonly unknown[] = Array.isArray(block.content) ? block.content : []
  const text = content.filter(object).filter(part => part.type === 'text' && typeof part.text === 'string')
    .map(part => String(part.text)).join('\n')
  const parsed: unknown = JSON.parse(text.split('\n')[0]!)
  return parsed
}

function toolEvents(id: string, name: string, input: object): object[] {
  return [
    { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id, name, input: {} } },
    { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 1 } },
  ]
}

function textEvents(text: string): object[] {
  return [
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
  ]
}

/**
 * Script only the marked conversation with advertised Website tools; unrelated title requests receive text.
 * Holds provider responses after completed tool results, keeping a genuine Agent turn open for Human gestures.
 * @returns an unbound loopback server, bounded-scenario observations and release/disposal controls.
 */
export function websiteModelFixture() {
  const requests: Record<string, unknown>[] = []
  const errors: string[] = []
  const held = new Map<Phase, { response: ServerResponse; events: object[] }>()
  const responses = new Set<ServerResponse>()
  let stopped = false
  let serial = 0
  let receipt: { requestId: string; profileId: string } | undefined
  let observed: Record<string, unknown> | undefined
  let denied = false

  const send = (response: ServerResponse, events: object[]): void => {
    serial++
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    const start = { type: 'message_start', message: { id: `native_msg_${serial}`, model: 'deepseek-flash', usage: { input_tokens: 1, output_tokens: 0 } } }
    response.end([start, ...events, { type: 'message_stop' }].map(event => `data: ${JSON.stringify(event)}\n\n`).join(''))
  }
  const hold = (phase: Phase, response: ServerResponse, events: object[]): void => {
    if (held.has(phase)) throw new Error('Duplicate held Website provider response')
    held.set(phase, { response, events })
    response.once('close', () => { if (held.get(phase)?.response === response) held.delete(phase) })
  }
  const server = createServer((request, response) => {
    responses.add(response)
    response.once('close', () => responses.delete(response))
    if (stopped) { response.writeHead(503).end(); return }
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => { chunks.push(chunk) })
    request.on('end', () => {
      try {
        const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        if (!object(body)) throw new Error('Website provider request must be an object')
        requests.push(body)
        const tools: readonly unknown[] = Array.isArray(body.tools) ? body.tools : []
        const names = tools.filter(object).map(tool => tool.name).filter((name): name is string => typeof name === 'string')
        if (!JSON.stringify(body.messages).includes(marker) || !names.includes('website_profiles')) {
          send(response, textEvents('Website acceptance'))
          return
        }
        const call = (id: string, name: string, args: object = {}): object[] => {
          if (!names.includes(name)) throw new Error('Website fixture attempted a tool not advertised to this request')
          return toolEvents(id, name, args)
        }
        const repeated = result(body, 'native_info_two')
        if (repeated) {
          if (repeated.is_error === true || JSON.stringify(value(repeated)) !== JSON.stringify(observed)) {
            throw new Error('Website repeated observation did not return the approved page information')
          }
          send(response, textEvents('WEBSITE_AGENT_COMPLETE')); return
        }
        if (result(body, 'native_refresh_two')) {
          if (!receipt) throw new Error('Website preparation receipt is missing')
          send(response, call('native_info_two', `website_page_info_${receipt.requestId}`)); return
        }
        const cancelled = result(body, 'native_info_denied')
        if (cancelled) {
          denied = cancelled.is_error === true
          hold('taken-over', response, call('native_refresh_two', 'website_profiles')); return
        }
        const info = result(body, 'native_info_one')
        if (info) {
          const output = value(info)
          if (info.is_error === true || !object(output)) throw new Error('Website page information result is missing')
          observed = output
          if (!receipt) throw new Error('Website preparation receipt is missing')
          hold('observed', response, call('native_info_denied', `website_page_info_${receipt.requestId}`)); return
        }
        if (result(body, 'native_refresh_one')) {
          if (!receipt) throw new Error('Website preparation receipt is missing')
          send(response, call('native_info_one', `website_page_info_${receipt.requestId}`)); return
        }
        const preparation = result(body, 'native_prepare')
        if (preparation) {
          const output = value(preparation)
          if (!object(output) || typeof output.requestId !== 'string' || typeof output.profileId !== 'string' || output.status !== 'pending') {
            throw new Error('Website preparation did not return its pending receipt')
          }
          receipt = { requestId: output.requestId, profileId: output.profileId }
          hold('prepared', response, call('native_refresh_one', 'website_profiles')); return
        }
        const profiles = result(body, 'native_profiles')
        if (profiles) {
          const output = value(profiles)
          const rows: readonly unknown[] = Array.isArray(output) ? output : []
          const profile = rows.filter(object).find(row => row.accountLabel === 'Agent fixture account')
          if (!profile || typeof profile.profileId !== 'string') throw new Error('Website fixture account was not advertised')
          send(response, call('native_prepare', 'website_prepare', { profileId: profile.profileId })); return
        }
        send(response, call('native_profiles', 'website_profiles'))
      } catch (_error: unknown) {
        // Neither failing provider bodies nor Human-only data are copied into diagnostics.
        errors.push('Website provider script rejected the current request')
        response.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { message: errors.at(-1) } }))
      }
    })
  })
  return {
    server, requests, errors, held, marker,
    get receipt() { return receipt },
    get observed() { return observed },
    get observationResult() { return requests.map(body => result(body, 'native_info_one')).find(Boolean) },
    get denied() { return denied },
    release(phase: Phase): void {
      const next = held.get(phase)
      if (!next) throw new Error(`Website provider response is not held: ${phase}`)
      held.delete(phase)
      send(next.response, next.events)
    },
    dispose(): void {
      stopped = true
      for (const response of responses) response.destroy()
      held.clear()
    },
  }
}
