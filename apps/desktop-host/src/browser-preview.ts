/** Stable preview tools for chat-owned native browser tabs, independent from saved-site MCP pairings. */
import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool, type ToolExecution } from '@deepseek-ai/dsh-tools'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { isJsonValue, type JsonValue } from '@deepseek-ai/dsh-util-values'
import type {} from '@deepseek-ai/dsh-attachment'

/** Caller-cancelled transport to the exact native application generation. */
export interface BrowserPreviewChannel {
  /** @param execution - live tool caller. @param operation - validated tool operation. @returns bounded native result. */
  invoke(execution: ToolExecution, operation: JsonValue): Promise<JsonValue>
  /** @param message - private Main response. @returns whether this channel consumed it. */
  receive(message: unknown): boolean
  /** Stop admission and reject outstanding calls. */
  close(): void
}

/** @param ctx - tool and lifecycle owner. @param send - exact Main IPC sender. @returns registered browser tools and transport. */
export function installBrowserPreview(ctx: Context, send: (message: object) => Promise<void>): BrowserPreviewChannel {
  const pending = new Map<string, { resolve: (value: JsonValue) => void; reject: (error: Error) => void }>()
  const images = new WeakMap<ToolExecution, ContentBlock[]>()
  let closed = false
  const channel: BrowserPreviewChannel = {
    async invoke(execution, operation) {
      const agent = execution.agent
      if (closed || agent === undefined || ctx.agents.get(agent.id) !== agent) throw new Error('Browser work requires a current owning chat')
      execution.signal.throwIfAborted()
      if (pending.size >= 64) throw new Error('Too many pending browser requests')
      const requestId = randomUUID()
      const completion = Promise.withResolvers<JsonValue>()
      void completion.promise.catch((_error: unknown) => { /* The original promise is awaited after private delivery settles. */ })
      const cancel = () => {
        completion.reject(new Error('Browser operation was canceled; a dispatched action may already have changed the page'))
        void send({ type: 'browser-preview-cancel', requestId }).catch((_error: unknown) => { /* Native channel loss also retires the caller. */ })
      }
      const timer = setTimeout(cancel, 60_000)
      pending.set(requestId, completion)
      execution.signal.addEventListener('abort', cancel, { once: true })
      ctx.tools.guardResult(execution, () => {
        if (closed || execution.signal.aborted || ctx.agents.get(agent.id) !== agent) throw new Error('Browser caller is no longer current')
        return undefined
      })
      try {
        const [, result] = await Promise.all([
          send({ type: 'browser-preview', requestId, sessionId: agent.session.id, operation }), completion.promise,
        ])
        execution.signal.throwIfAborted()
        if (ctx.agents.get(agent.id) !== agent) throw new Error('Browser caller is no longer current')
        return result
      } finally { clearTimeout(timer); execution.signal.removeEventListener('abort', cancel); pending.delete(requestId) }
    },
    receive(input) {
      if (typeof input !== 'object' || input === null || !('type' in input) || input.type !== 'browser-preview-result') return false
      if (!('requestId' in input) || typeof input.requestId !== 'string') return true
      const call = pending.get(input.requestId)
      if (call === undefined) return true
      if ('ok' in input && input.ok === false && 'error' in input && typeof input.error === 'string') call.reject(new Error(input.error.slice(0, 2048)))
      else if ('ok' in input && input.ok === true && 'result' in input && isJsonValue(input.result)
        && Buffer.byteLength(JSON.stringify(input.result)) <= 8 * 1024 * 1024) call.resolve(input.result as JsonValue)
      else call.reject(new Error('Browser returned an invalid native response'))
      return true
    },
    close() {
      closed = true
      for (const call of pending.values()) call.reject(new Error('Browser Host is stopping'))
      pending.clear()
    },
  }
  const output = { schema: { type: 'json' } as const,
    render: (_args: object, value: JsonValue): ContentBlock[] => [{ type: 'text', text: JSON.stringify(value) }] }
  const tabId = { type: 'string', description: 'Exact native tabId from preview_status or preview_open.' } as const
  ctx.effect(() => () => { channel.close() })
  ctx.inject(['tools'], scope => scope.effect(function* () {
    yield ctx.tools.register(defineTool({ name: 'preview_status',
      description: 'Report browser tabs belonging to this chat or unclaimed tabs, including URL, title, loading, chat owner, human control and generation. A selected tab can be observed while the human drives it; actions require your own or an unclaimed tab with no human in control.',
      parameters: { tabId }, output,
      execute: (args, execution) => channel.invoke(execution, { kind: 'status', ...args }),
      presentCall: () => ({ card: 'generic', title: 'Browser tab status', kind: 'read' }),
    }))
    yield ctx.tools.register(defineTool({ name: 'preview_open',
      description: 'Open a browser tab in this chat. Reuses this chat\'s current agent-controlled tab unless reuseExistingTab=false. Parallel agents must each use reuseExistingTab=false and retain the returned tabId. Uses the visible native browser; no MCP pairing or saved-profile preparation is required.',
      parameters: { url: { type: 'string', required: true, description: 'Credential-free HTTP(S) address.' },
        profileId: { type: 'string', description: 'Optional saved account profileId from preview_status; uses its existing browser login.' },
        reuseExistingTab: { type: 'boolean' } }, output,
      execute: (args, execution) => channel.invoke(execution, { kind: 'open', ...args }),
      presentCall: () => ({ card: 'generic', title: 'Open browser tab', kind: 'other' }),
    }))
    yield ctx.tools.register(defineTool({ name: 'preview_navigate',
      description: 'Navigate an owned or unclaimed browser tab. Refuses another chat\'s tab and human control.',
      parameters: { tabId: { ...tabId, required: true }, url: { type: 'string', required: true } }, output,
      execute: (args, execution) => channel.invoke(execution, { kind: 'navigate', ...args }),
      presentCall: () => ({ card: 'generic', title: 'Navigate browser tab', kind: 'other' }),
    }))
    yield ctx.tools.register(defineTool({ name: 'preview_evaluate',
      description: 'Run JavaScript in an owned or unclaimed browser tab with no human in control. Can read or change the page; result must be JSON serializable and at most 64 KB. Use preview_snapshot to observe a tab the human drives. Never extract authentication secrets.',
      parameters: { tabId: { ...tabId, required: true }, expression: { type: 'string', required: true, description: 'Page JavaScript expression, at most 64 KB UTF-8. Result must be JSON serializable.' } }, output,
      execute: (args, execution) => channel.invoke(execution, { kind: 'evaluate', ...args }),
      presentCall: () => ({ card: 'generic', title: 'Evaluate browser page', kind: 'other' }),
    }))
    yield ctx.tools.register(defineTool({ name: 'preview_act',
      description: 'Act in an owned or unclaimed native browser tab with no human in control. click accepts selector or x/y; type replaces a field; hover and select use selector; press sends key; scroll uses deltaX/deltaY with optional x/y. Actions report attempted; inspect afterward to verify their effect.',
      parameters: { tabId: { ...tabId, required: true }, action: { type: 'string', required: true, enum: ['click', 'type', 'hover', 'select', 'press', 'scroll', 'drag'] },
        selector: { type: 'string', description: 'CSS selector from preview_snapshot, at most 4096 UTF-8 bytes.' },
        frameSelector: { type: 'string', description: 'Optional same-origin iframe selector from preview_snapshot; selector is resolved inside that frame.' },
        text: { type: 'string', description: 'Replacement field text, at most 8192 UTF-8 bytes.' }, value: { type: 'string', description: 'Native select value, at most 8192 UTF-8 bytes.' },
        key: { type: 'string', description: 'Electron key name, at most 64 UTF-8 bytes, such as Enter or Tab.' },
        source: { type: 'string', description: 'Drag source CSS selector, at most 4096 UTF-8 bytes.' }, target: { type: 'string', description: 'Drag destination CSS selector, at most 4096 UTF-8 bytes.' },
        x: { type: 'number', description: 'Viewport X coordinate; finite, magnitude at most 100000.' }, y: { type: 'number', description: 'Viewport Y coordinate; finite, magnitude at most 100000.' },
        deltaX: { type: 'number', description: 'Horizontal scroll amount; finite, magnitude at most 100000.' }, deltaY: { type: 'number', description: 'Vertical scroll amount; finite, magnitude at most 100000.' } }, output,
      execute: (args, execution) => channel.invoke(execution, { kind: 'act', ...args }),
      presentCall: args => ({ card: 'generic', title: `Browser ${args.action}`, kind: 'other' }),
    }))
    yield ctx.tools.register(defineTool({ name: 'preview_resize',
      description: 'Resize an owned or unclaimed browser tab viewport in CSS pixels. Does not change the user agent. Human control and other chat ownership refuse the operation.',
      parameters: { tabId: { ...tabId, required: true }, width: { type: 'integer', required: true, description: 'Viewport width, 1–8192 CSS pixels.' }, height: { type: 'integer', required: true, description: 'Viewport height, 1–8192 CSS pixels.' } }, output,
      execute: (args, execution) => channel.invoke(execution, { kind: 'resize', ...args }),
      presentCall: () => ({ card: 'generic', title: 'Resize browser viewport', kind: 'other' }),
    }))
    yield ctx.tools.register(defineTool({ name: 'preview_snapshot',
      description: 'Read a browser tab including while the human controls it. Returns native page state, bounded page text and interactive elements. includeImage=true also captures and attaches a screenshot to this chat. Use only for requested browser work or checking an edit in the browser.',
      parameters: { tabId: { ...tabId, required: true }, includeImage: { type: 'boolean' } }, output,
      projectContent: execution => images.get(execution),
      async execute(args, execution) {
        if (args.includeImage) {
          const agent = execution.agent
          if (agent === undefined) throw new Error('Browser screenshots require an owning chat')
          const header = agent.session.requestHeader()?.config
          const provider = header?.provider ?? agent.options.provider
          const model = header?.model ?? agent.options.model
          const llm = agent.ctx.get('llm')
          if (llm === undefined || provider === undefined || model === undefined) throw new Error('Browser screenshots require an image-capable active model')
          const info = await llm.resolveModelInfo(provider, model, execution.signal)
          if (!info.inputModalities?.includes('image')) throw new Error('Browser screenshots require an image-capable active model')
        }
        const result = await channel.invoke(execution, { kind: 'snapshot', ...args })
        if (!args.includeImage) return result
        if (result === null || typeof result !== 'object' || Array.isArray(result)) throw new Error('Browser screenshot response is invalid')
        const screenshot = result.screenshot
        if (screenshot === null || typeof screenshot !== 'object' || Array.isArray(screenshot) || typeof screenshot.png !== 'string') throw new Error('Browser screenshot is unavailable')
        const attachments = execution.agent?.ctx.get('attachments')
        if (attachments === undefined) throw new Error('Browser screenshots require durable image storage')
        const refs = await attachments.saveImages([{ data: Buffer.from(screenshot.png, 'base64'), mediaType: 'image/png', name: 'browser-screenshot.png' }])
        const ref = refs[0]
        if (ref === undefined) throw new Error('Browser screenshot storage returned no reference')
        execution.signal.throwIfAborted()
        const { screenshot: _screenshot, ...page } = result
        const value = { ...page, screenshot: {
          attachmentId: ref.attachmentId, mediaType: ref.mediaType, width: ref.width, height: ref.height,
        } }
        images.set(execution, [{ type: 'text', text: JSON.stringify(value) }, { type: 'image', attachment: ref }])
        return value
      },
      presentCall: () => ({ card: 'generic', title: 'Inspect browser page', kind: 'read' }),
    }))
  }, 'browser preview tools'))
  return channel
}
