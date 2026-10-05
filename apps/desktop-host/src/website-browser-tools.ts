/** One request-scoped browser fallback with explicit operation, bounded arguments and durable screenshot admission. */
import { defineTool, type ToolExecution } from '@deepseek-ai/dsh-tools'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-attachment'
import type { DesktopWebsiteBrowserOperation } from '@deepseek-ai/dsh-client-ui-sidebar-browser/types'
import type { WebsiteRequestToolScope } from './website-requests.ts'
import type { WebsiteParentChannel } from './website-parent.ts'
import { websiteHostSnapshot } from './website-control.ts'

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function string(value: unknown, bytes: number, empty = false): string {
  if (typeof value !== 'string' || (!empty && value.length === 0) || Buffer.byteLength(value) > bytes) throw new Error('Website browser string argument rejected')
  return value
}

function integer(value: unknown, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) throw new Error('Website browser numeric argument rejected')
  return value
}

function selector(value: unknown): string {
  const text = string(value, 512)
  const simple = '(?:[a-zA-Z][a-zA-Z0-9-]*|\\*|[.#][a-zA-Z_][a-zA-Z0-9_-]*)(?:[.#][a-zA-Z_][a-zA-Z0-9_-]*)*'
  if (!new RegExp(`^${simple}(?:(?: +| *> *)${simple})*$`).test(text)) throw new Error('Website browser selector rejected')
  return text
}

function address(value: unknown): string {
  const text = string(value, 4096)
  if (/[\p{Cc}\p{Cf}]/u.test(text) || text.trim() !== text || text.includes('\\')) throw new Error('Website browser URL rejected')
  const authority = /^https?:\/\/([^/?#]+)/i.exec(text)?.[1]
  if (authority === undefined || authority.includes('@') || !URL.canParse(text)) throw new Error('Website browser URL rejected')
  const url = new URL(text)
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error('Website browser URL rejected')
  return text
}

type BrowserOperation = Exclude<DesktopWebsiteBrowserOperation, { kind: 'evaluate' }>

function resolveOperation(args: unknown): { operation: BrowserOperation; fallbackReason: string } {
  if (!record(args)) throw new Error('Website browser arguments rejected')
  const fallbackReason = string(args.fallbackReason, 512)
  let operation: BrowserOperation
  let fields: string[]
  switch (args.operation) {
    case 'dom-read':
      operation = { kind: 'dom-read', selector: selector(args.selector),
        maxElements: integer(args.maxElements, 1, 32), maxTextChars: integer(args.maxTextChars, 1, 2048) }
      fields = ['selector', 'maxElements', 'maxTextChars']; break
    case 'click':
      operation = { kind: 'click', selector: selector(args.selector) }
      fields = ['selector']; break
    case 'fill':
      operation = { kind: 'fill', selector: selector(args.selector), text: string(args.text, 8192, true) }
      fields = ['selector', 'text']; break
    case 'navigate':
      operation = { kind: 'navigate', url: address(args.url) }
      fields = ['url']; break
    case 'screenshot': {
      if (!record(args.clip) || Object.keys(args.clip).length !== 4) throw new Error('Website screenshot clip rejected')
      operation = { kind: 'screenshot', clip: { x: integer(args.clip.x, 0, 4096), y: integer(args.clip.y, 0, 4096),
        width: integer(args.clip.width, 1, 1024), height: integer(args.clip.height, 1, 1024) } }
      fields = ['clip']; break
    }
    default: throw new Error('Website browser operation rejected')
  }
  const expected = ['operation', 'fallbackReason', ...fields]
  if (Object.keys(args).length !== expected.length || !expected.every(key => Object.hasOwn(args, key))
    || Buffer.byteLength(JSON.stringify(args)) > 64 * 1024) throw new Error('Website browser operation arguments rejected')
  return { operation, fallbackReason }
}

/** @param scope - exact committed native request and captured initiating Agent. @param parent - independent physical settlement channel.
 * @returns synchronous tool removal, retained by the request until revocation.
 */
export function installWebsiteBrowserTool(scope: WebsiteRequestToolScope, parent: WebsiteParentChannel): () => void {
  const projections = new WeakMap<ToolExecution, { value: string; content: ContentBlock[] }>()
  return scope.agent.ctx.tools.register(defineTool({
    name: `website_browser_${scope.request.requestId}`,
    description: `Work in the approved saved website ${JSON.stringify(scope.profile.name)} / account ${JSON.stringify(scope.profile.accountLabel)}. Prefer its paired MCP. Use browser fallback only when MCP cannot perform the task; provide the reason and obtain fresh one-call approval. Never access passwords, verification codes, login content or authentication secrets. DOM reads return bounded top-document text, omitting controls and commonly hidden subtrees. Click/fill/navigation can mutate the website. Arbitrary JavaScript is unavailable; scripts or workers could outlive Human takeover. Screenshots persist in this conversation and require an image-capable active model. Actions report attempted, not successful.`,
    parameters: {
      operation: { type: 'string', enum: ['dom-read', 'click', 'fill', 'navigate', 'screenshot'], required: true },
      fallbackReason: { type: 'string', required: true, description: 'Why the paired MCP cannot perform this task; nonempty, at most 512 UTF-8 bytes, no control characters.' },
      selector: { type: 'string', description: 'Required for dom-read/click/fill: simple tag, #id, .class, descendant or child selector; at most 512 UTF-8 bytes.' },
      maxElements: { type: 'integer', description: 'Required for dom-read: maximum matched elements, 1–32.' },
      maxTextChars: { type: 'integer', description: 'Required for dom-read: maximum text code points per element, 1–2048.' },
      text: { type: 'string', description: 'Required for fill: replacement text, at most 8192 UTF-8 bytes; never authentication data.' },
      url: { type: 'string', description: 'Required for navigate: credential-free same-origin HTTP(S) address, at most 4096 UTF-8 bytes.' },
      clip: { type: 'object', additionalProperties: false, description: 'Required for screenshot: rectangle within the current viewport.', properties: {
        x: { type: 'integer', required: true, description: 'Left coordinate, 0–4096.' }, y: { type: 'integer', required: true, description: 'Top coordinate, 0–4096.' },
        width: { type: 'integer', required: true, description: 'Width, 1–1024.' }, height: { type: 'integer', required: true, description: 'Height, 1–1024.' },
      } },
    },
    output: { schema: { oneOf: [
      { type: 'object', additionalProperties: false, properties: {
        operation: { type: 'string', enum: ['dom-read', 'click', 'fill', 'navigate'], required: true },
        observation: { type: 'json', required: true },
      } },
      { type: 'object', additionalProperties: false, properties: {
        operation: { type: 'string', const: 'screenshot', required: true }, attachmentId: { type: 'string', required: true },
        mediaType: { type: 'string', enum: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'], required: true },
        bytes: { type: 'integer', required: true }, width: { type: 'integer', required: true }, height: { type: 'integer', required: true },
      } },
    ] }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    projectContent(execution, result) {
      const prepared = projections.get(execution)
      if (prepared !== undefined && JSON.stringify(result.value) === prepared.value) return prepared.content
      return undefined
    },
    async execute(args, execution) {
      const { operation, fallbackReason } = resolveOperation(args)
      scope.agent.ctx.tools.guardResult(execution, (result) => {
        if (Buffer.byteLength(JSON.stringify(result)) > 128 * 1024) throw new Error('Website browser operation exceeded the complete result limit')
        return undefined
      })
      const consent = { operation: operation.kind === 'dom-read' ? 'dom' as const : operation.kind,
        fallbackReason, details: JSON.stringify(operation) }
      return scope.run(execution, async (signal) => {
        const attachments = operation.kind === 'screenshot' ? scope.agent.ctx.get('attachments') : undefined
        if (operation.kind === 'screenshot') {
          if (attachments === undefined) throw new Error('Website screenshots require durable image storage')
          const header = scope.agent.session.requestHeader()?.config
          const provider = header?.provider ?? scope.agent.options.provider
          const model = header?.model ?? scope.agent.options.model
          const llm = scope.agent.ctx.get('llm')
          if (llm === undefined || provider === undefined || model === undefined) throw new Error('Website screenshots require an image-capable active model')
          const info = await llm.resolveModelInfo(provider, model, signal)
          signal.throwIfAborted()
          if (!info.inputModalities?.includes('image')) throw new Error('Website screenshots require an image-capable active model')
        }
        const native = parent.beginOperation(websiteHostSnapshot(scope.request), operation, signal)
        let result
        try { result = await native.result }
        finally { await native.settled }
        signal.throwIfAborted()
        if (result.kind === 'json') {
          if (operation.kind === 'screenshot') throw new Error('Website screenshot admission rejected')
          return { operation: operation.kind, observation: result.value }
        }
        if (operation.kind !== 'screenshot' || attachments === undefined) throw new Error('Website screenshot admission rejected')
        const refs = await attachments.saveImages([{ data: Buffer.from(result.png, 'base64'), mediaType: 'image/png', name: 'website-screenshot.png' }])
        signal.throwIfAborted()
        const ref = refs[0]
        if (ref === undefined) throw new Error('Website screenshot storage returned no reference')
        const value = { operation: 'screenshot' as const, attachmentId: ref.attachmentId, mediaType: ref.mediaType,
          bytes: ref.bytes, width: ref.width, height: ref.height }
        projections.set(execution, { value: JSON.stringify(value), content: [
          { type: 'text', text: JSON.stringify(value) }, { type: 'image', attachment: ref },
        ] })
        return value
      }, consent)
    },
    presentCall: args => ({ card: 'generic', title: `Approved website browser: ${args.operation}`, kind: 'other' }),
  }))
}
