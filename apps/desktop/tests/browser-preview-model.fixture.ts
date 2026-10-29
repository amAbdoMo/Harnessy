/** Owned Messages provider drives genuine preview tools through native tab control handoffs. */
import { createServer, type ServerResponse } from 'node:http'

function record(input: unknown): input is Record<string, unknown> { return typeof input === 'object' && input !== null && !Array.isArray(input) }

function toolResult(body: Record<string, unknown>, id: string): Record<string, unknown> | undefined {
  const messages = Array.isArray(body.messages) ? body.messages : []
  return messages.filter(record).flatMap(message => Array.isArray(message.content) ? message.content.filter(record) : [])
    .find(block => block.type === 'tool_result' && block.tool_use_id === id)
}

function parsedResult(block: Record<string, unknown>): Record<string, unknown> {
  const content = Array.isArray(block.content) ? block.content.filter(record) : []
  const text = content.filter(part => part.type === 'text').map(part => String(part.text)).join('\n')
  const parsed: unknown = JSON.parse(text)
  if (!record(parsed)) throw new Error('Expected a browser result object')
  return parsed
}

/** @param url - owned public fixture address. @returns provider, phase barriers and its inspected native results. */
export function browserPreviewModelFixture(url: string) {
  const marker = 'NATIVE_BROWSER_PREVIEW_ACCEPTANCE'
  const errors: string[] = []
  const requests: Record<string, unknown>[] = []
  const held = new Map<string, () => void>()
  const responses = new Set<ServerResponse>()
  let tabId: string | undefined
  let profileId: string | undefined
  let denied = false
  let observedDuringHuman = false
  let serial = 0
  const send = (response: ServerResponse, events: object[]): void => {
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.end([{ type: 'message_start', message: { id: `preview_${++serial}`, model: 'deepseek-flash', usage: { input_tokens: 1, output_tokens: 0 } } },
      ...events, { type: 'message_stop' }].map(event => `data: ${JSON.stringify(event)}\n\n`).join(''))
  }
  const call = (id: string, name: string, input: object): object[] => [
    { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id, name, input: {} } },
    { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) } },
    { type: 'content_block_stop', index: 0 }, { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 1 } },
  ]
  const text = (message: string): object[] => [
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: message } },
    { type: 'content_block_stop', index: 0 }, { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
  ]
  const hold = (phase: string, response: ServerResponse, events: object[]): void => {
    held.set(phase, () => { held.delete(phase); send(response, events) })
    response.once('close', () => { held.delete(phase) })
  }
  const server = createServer((request, response) => {
    responses.add(response)
    response.once('close', () => { responses.delete(response) })
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => { chunks.push(chunk) })
    request.on('end', () => {
      try {
        const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        if (!record(body)) throw new Error('Invalid provider body')
        requests.push(body)
        const tools = Array.isArray(body.tools) ? body.tools.filter(record) : []
        if (!JSON.stringify(body.messages).includes(marker) || !tools.some(tool => tool.name === 'preview_open')) { send(response, text('Browser preview acceptance')); return }
        if (tools.some(tool => tool.name === 'website_prepare' || tool.name === 'website_profiles')) throw new Error('Retired website tools remain in the default browser inventory')
        if (profileId !== undefined) {
          const mcp = toolResult(body, 'preview_mcp')
          if (mcp === undefined) { send(response, call('preview_mcp', 'mcp__website_fixture__fixture_status', {})); return }
          if (mcp.is_error === true || !JSON.stringify(mcp).includes('fixture available')) throw new Error('Independent MCP access was blocked by browser pairing')
        }
        const resumed = toolResult(body, 'preview_resumed')
        if (resumed) {
          if (resumed.is_error === true || parsedResult(resumed).value !== 'Resumed browser agent') throw new Error('Resumed evaluation failed')
          send(response, text('BROWSER_PREVIEW_COMPLETE')); return
        }
        const snapshot = toolResult(body, 'preview_human_snapshot')
        if (snapshot) {
          const observed = parsedResult(snapshot)
          observedDuringHuman = snapshot.is_error !== true && observed.humanControl === true
          if (!observedDuringHuman) throw new Error('Human-mode observation failed')
          hold('human-observed', response, call('preview_resumed', 'preview_evaluate', { tabId, expression: "document.title='Resumed browser agent';document.title" })); return
        }
        const refusal = toolResult(body, 'preview_denied')
        if (refusal) {
          denied = refusal.is_error === true
          if (!denied) throw new Error('Human takeover did not refuse agent evaluation')
          send(response, call('preview_human_snapshot', 'preview_snapshot', { tabId })); return
        }
        const changed = toolResult(body, 'preview_changed')
        if (changed) {
          if (changed.is_error === true || parsedResult(changed).value !== 'Agent edited page') throw new Error('Initial evaluation failed')
          hold('agent-observed', response, call('preview_denied', 'preview_evaluate', { tabId, expression: "document.title='UNSAFE human mutation'" })); return
        }
        const opening = toolResult(body, 'preview_opened')
        if (opening) {
          const opened = parsedResult(opening)
          if (opening.is_error === true || typeof opened.tabId !== 'string') throw new Error('Native browser did not open')
          tabId = opened.tabId
          send(response, call('preview_changed', 'preview_evaluate', { tabId, expression: "document.title='Agent edited page';document.title" })); return
        }
        send(response, call('preview_opened', 'preview_open', { url, reuseExistingTab: false,
          ...(profileId === undefined ? {} : { profileId }) }))
      } catch (error) {
        errors.push(error instanceof Error ? error.message : 'Browser provider failed')
        response.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { message: errors.at(-1) } }))
      }
    })
  })
  return { server, marker, errors, requests, held,
    useProfile(id: string): void { profileId = id },
    get tabId() { return tabId }, get denied() { return denied }, get observedDuringHuman() { return observedDuringHuman },
    release(phase: string): void { const release = held.get(phase); if (release === undefined) throw new Error('Provider phase is not pending'); release() },
    dispose(): void { for (const response of responses) response.destroy(); held.clear() },
  }
}
