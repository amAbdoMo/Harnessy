/** Explicit preview preparation/opening and separately approved, durable page observations. */
import { symbols, type Context } from '@deepseek-ai/cordis'
import { randomUUID } from 'node:crypto'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { defineTool, type ToolExecution } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-attachment'
import type { ApprovalService } from '@deepseek-ai/dsh-user-approval'
import type { DevicePreviewId, DevicePreviewSlot } from '@deepseek-ai/dsh-client-ui-device-preview/types'
import type { DevicePreviewController } from './device-preview-controller.ts'
import type { DevicePreviewParentChannel } from './device-preview-parent.ts'

// Complete emitted outcomes, including escaped text, image references and presentation metadata.
const RESULT_BYTES = 256 * 1024
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const serverSchema = { type: 'object', additionalProperties: false, properties: {
  projectId: { type: 'string' }, cwd: { type: 'string', required: true }, command: { type: 'string' },
  url: { type: 'string', required: true }, ownership: { type: 'string', enum: ['external', 'owned'], required: true },
  status: { type: 'string', enum: ['external', 'starting', 'running', 'stopped', 'failed'], required: true },
  jobId: { type: 'string' }, error: { type: 'string' },
} } as const

type ObservationRequest = { previewId: DevicePreviewId; slot: DevicePreviewSlot; operation: 'screenshot' | 'layout' }
type Invocation = { agent: Agent; signal: AbortSignal }

function argumentsOnly(args: object, fields: readonly string[]): void {
  if (Object.keys(args).some(field => !fields.includes(field))) throw new Error('Unexpected device preview argument')
}

function boundedText(text: string, bytes: number): string {
  if (!text.trim() || Buffer.byteLength(text) > bytes || /[\p{Cc}\p{Cf}]/u.test(text)) {
    throw new Error('Device preview argument is empty, too long or contains control characters')
  }
  return text
}

function uuid(text: string): string {
  if (!UUID.test(text)) throw new Error('Use the exact recorded device preview identifier')
  return text
}

function address(text: string): string {
  boundedText(text, 2048)
  if (text.trim() !== text || /[\s\\]/u.test(text) || !/^https?:\/\//i.test(text) || !URL.canParse(text)) {
    throw new Error('Device preview requires a credential-free HTTP(S) URL')
  }
  const url = new URL(text)
  const authority = /^https?:\/\/([^/?#]+)/i.exec(text)?.[1]
  if (url.username || url.password || authority?.includes('@')) throw new Error('Device preview URL must not contain credentials')
  return url.href
}

function currentObservationApproval(agent: Agent, approved: ApprovalService): void {
  const current = agent.ctx.get('approval')
  // Caller-bound Cordis proxies can differ while naming the same provider.
  if (current === undefined || (Reflect.get(current, symbols.original) ?? current) !== (Reflect.get(approved, symbols.original) ?? approved)
    || (current.overrideOf(agent.session) ?? current.config.policy) === 'never') {
    throw new Error('Device preview observation approval is no longer available')
  }
}

async function screenshotStorage({ agent, signal }: Invocation) {
  const attachments = agent.ctx.get('attachments')
  if (attachments === undefined) throw new Error('Device preview screenshots require durable image storage')
  const header = agent.session.requestHeader()?.config
  const provider = header?.provider ?? agent.options.provider
  const model = header?.model ?? agent.options.model
  const llm = agent.ctx.get('llm')
  if (llm === undefined || provider === undefined || model === undefined) {
    throw new Error('Device preview screenshots require an image-capable active model')
  }
  const modelInfo = await llm.resolveModelInfo(provider, model, signal)
  signal.throwIfAborted()
  if (!modelInfo.inputModalities?.includes('image')) throw new Error('Device preview screenshots require an image-capable active model')
  return attachments
}

/**
 * @param ctx - prepared Desktop Host lifetime; tools wait for the configured registry.
 * @param controller - immutable project plans and owned managed launchers.
 * @param parent - private committed-opening and bounded-observation channel.
 * @returns disposable tool injection with readiness to await after profile service loading. Opening grants no observation permission.
 */
export function installDevicePreviewTools(
  ctx: Context, controller: DevicePreviewController, parent: DevicePreviewParentChannel,
): ReturnType<Context['inject']> {
  return ctx.inject(['tools'], (scope) => {
    const lifetime = new AbortController()
    const pending = new Set<Promise<unknown>>()
    const previews = new Map<DevicePreviewId, { agent: Agent; opened: boolean }>()
    scope.effect(() => parent.onRetired((previewId) => { previews.delete(previewId) }))
    scope.on('agent/disposed', ({ agent }) => {
      for (const [id, preview] of previews) if (preview.agent === agent) previews.delete(id)
    })
    const projections = new WeakMap<ToolExecution, { receipt: string; content: ContentBlock[] }>()
    scope.effect(() => async () => {
      lifetime.abort()
      previews.clear()
      await Promise.allSettled([...pending])
    })

    async function run<T>(execution: ToolExecution, operation: (invocation: Invocation) => Promise<T>): Promise<T> {
      if (execution.agent === undefined) throw new Error('Device preview requires an initiating Agent Session')
      const signal = AbortSignal.any([execution.signal, lifetime.signal])
      signal.throwIfAborted()
      scope.tools.guardResult(execution, (outcome) => {
        signal.throwIfAborted()
        if (Buffer.byteLength(JSON.stringify(outcome)) > RESULT_BYTES) throw new Error('Device preview exceeded the complete result limit')
        return undefined
      })
      const work = operation({ agent: execution.agent, signal })
      pending.add(work)
      try { return await work }
      finally { pending.delete(work) }
    }

    async function observe(request: ObservationRequest, execution: ToolExecution, invocation: Invocation) {
      const { agent, signal } = invocation
      const preview = previews.get(request.previewId)
      if (preview?.agent !== agent || !preview.opened) throw new Error('Use a preview opened by this Agent Session')
      const approval = agent.ctx.get('approval')
      if (approval === undefined) throw new Error('Device preview observation requires available human approval')
      scope.tools.guardResult(execution, (outcome) => {
        if (!outcome.isError) {
          if (previews.get(request.previewId) !== preview) throw new Error('Device preview was closed')
          currentObservationApproval(agent, approval)
        }
        return undefined
      })
      const outcome = await approval.request({ agent, toolName: execution.name, callId: execution.callId, signal,
        reason: `Read ${request.operation} from the ${request.slot} pane of preview ${request.previewId}. Permission applies only to this call; opening grants no page access.`,
        detailMode: 'summary-only' })
      signal.throwIfAborted()
      if (outcome !== 'allowed-once') throw new Error('Device preview observation was not approved')
      const attachments = request.operation === 'screenshot' ? await screenshotStorage(invocation) : undefined
      currentObservationApproval(agent, approval)
      if (previews.get(request.previewId) !== preview) throw new Error('Device preview was closed')
      const observation = await parent.observe({ ...request, sessionId: agent.session.id }, signal)
      signal.throwIfAborted()
      if (observation.kind === 'layout') return { ...request, ...observation, operation: 'layout' as const }
      if (attachments === undefined) throw new Error('Device preview screenshot admission rejected')
      const refs = await attachments.saveImages([{ data: Buffer.from(observation.base64, 'base64'),
        mediaType: 'image/png', name: `device-preview-${request.slot}.png` }])
      signal.throwIfAborted()
      const ref = refs[0]
      if (ref === undefined) throw new Error('Device preview screenshot storage returned no reference')
      const receipt = { ...request, operation: 'screenshot' as const, kind: 'screenshot' as const, attachmentId: ref.attachmentId,
        mediaType: ref.mediaType, bytes: ref.bytes, width: ref.width, height: ref.height }
      projections.set(execution, { receipt: JSON.stringify(receipt), content: [
        { type: 'text', text: JSON.stringify(receipt) }, { type: 'image', attachment: ref },
      ] })
      return receipt
    }

    scope.tools.register(defineTool({
      name: 'device_preview_project',
      description: 'Detect existing web preview scripts in a project and optionally prepare an exact launch plan. Never launches, installs dependencies, edits files or inspects a page. Choose an existing script and its known or explicitly supplied URL; do not guess the URL. Use the returned projectId and exact plan URL with device_preview_open.',
      parameters: {
        project: { type: 'string', required: true, description: 'Existing project directory, relative to this conversation workspace or absolute; at most 4096 UTF-8 bytes.' },
        script: { type: 'string', description: 'Exact existing web script selected from the detected choices; at most 128 UTF-8 bytes.' },
        url: { type: 'string', description: 'Explicit credential-free HTTP(S) endpoint for this script; at most 2048 UTF-8 bytes.' },
      },
      output: { schema: { type: 'object', additionalProperties: false, properties: {
        project: { type: 'string', required: true }, needsInput: { type: 'boolean', required: true },
        choices: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
          script: { type: 'string', required: true }, command: { type: 'string', required: true }, knownUrl: { type: 'string' },
        } } },
        plan: { type: 'object', additionalProperties: false, properties: {
          projectId: { type: 'string', required: true }, cwd: { type: 'string', required: true },
          command: { type: 'string', required: true }, url: { type: 'string', required: true },
        } },
      } }, render: (_args, prepared) => [{ type: 'text', text: JSON.stringify(prepared) }],
      presentationMeta: (_args, prepared) => ({ devicePreview: prepared }) },
      execute(args, execution) {
        argumentsOnly(args, ['project', 'script', 'url'])
        const request = { project: boundedText(args.project, 4096),
          ...args.script === undefined ? {} : { script: boundedText(args.script, 128) },
          ...args.url === undefined ? {} : { url: address(args.url) } }
        return run(execution, ({ signal }) => controller.project(request, { ...execution, signal }))
      },
      presentCall: args => ({ card: 'generic', title: 'Prepare device preview project', kind: 'read', rawInput: args.project }),
    }))
    scope.tools.register(defineTool({
      name: 'device_preview_open',
      description: 'Open a device preview using the exact projectId and URL returned by device_preview_project, or open an external HTTP(S) URL without projectId. A prepared launcher requires human approval; external servers are never owned or stopped. Returns the committed previewId and server ownership/status, not HTTP readiness or page data. Opening does not authorize screenshots or layout reads; use device_preview_observe for separately approved observations.',
      parameters: {
        url: { type: 'string', required: true, description: 'Exact prepared plan URL, or an external credential-free HTTP(S) URL; at most 2048 UTF-8 bytes.' },
        projectId: { type: 'string', description: 'Exact projectId from device_preview_project; omit only for an external server.' },
      },
      output: { schema: { type: 'object', additionalProperties: false, properties: {
        kind: { type: 'string', const: 'opened', required: true }, previewId: { type: 'string', required: true },
        server: { ...serverSchema, required: true },
      } }, render: (_args, opened) => [{ type: 'text', text: JSON.stringify(opened) }],
      presentationMeta: (_args, opened) => ({ devicePreview: opened }) },
      execute(args, execution) {
        argumentsOnly(args, ['url', 'projectId'])
        const request = { url: address(args.url), ...args.projectId === undefined ? {} : { projectId: uuid(args.projectId) } }
        return run(execution, async ({ agent, signal }) => {
          const server = await controller.open(request, { ...execution, signal })
          signal.throwIfAborted()
          const previewId = randomUUID() as DevicePreviewId
          const preview = { agent, opened: false }
          previews.set(previewId, preview)
          try {
            const opened = await parent.open({ previewId, sessionId: agent.session.id, server }, signal)
            signal.throwIfAborted()
            if (previews.get(previewId) !== preview) throw new Error('Device preview was closed before opening completed')
            preview.opened = true
            scope.tools.guardResult(execution, (outcome) => {
              if (!outcome.isError && previews.get(previewId) !== preview) throw new Error('Device preview was closed')
              return undefined
            })
            return { ...opened, server }
          } catch (error: unknown) {
            if (previews.get(previewId) === preview) previews.delete(previewId)
            throw error
          }
        })
      },
      presentCall: args => ({ card: 'generic', title: 'Open device preview', kind: 'other', rawInput: args.url }),
    }))
    scope.tools.register(defineTool({
      name: 'device_preview_observe',
      description: 'Read one screenshot or bounded layout from a previewId previously opened in this conversation, choosing exactly the phone or tablet pane. Every call asks for fresh approval for that operation and pane; opening grants no page access. Screenshots persist as image attachments and require an image-capable active model. No clicks, typing, navigation, scripts or automatic inspection are available.',
      parameters: {
        previewId: { type: 'string', required: true, description: 'Exact previewId returned by device_preview_open in this conversation.' },
        slot: { type: 'string', enum: ['phone', 'tablet'], required: true, description: 'The one device pane to read.' },
        operation: { type: 'string', enum: ['screenshot', 'layout'], required: true, description: 'One separately approved observation.' },
      },
      output: { schema: { oneOf: [
        { type: 'object', additionalProperties: false, properties: {
          previewId: { type: 'string', required: true }, slot: { type: 'string', enum: ['phone', 'tablet'], required: true },
          operation: { type: 'string', const: 'layout', required: true }, kind: { type: 'string', const: 'layout', required: true },
          text: { type: 'string', required: true }, width: { type: 'integer', required: true }, height: { type: 'integer', required: true },
        } },
        { type: 'object', additionalProperties: false, properties: {
          previewId: { type: 'string', required: true }, slot: { type: 'string', enum: ['phone', 'tablet'], required: true },
          operation: { type: 'string', const: 'screenshot', required: true }, kind: { type: 'string', const: 'screenshot', required: true },
          attachmentId: { type: 'string', required: true }, mediaType: { type: 'string', enum: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'], required: true },
          bytes: { type: 'integer', required: true }, width: { type: 'integer', required: true }, height: { type: 'integer', required: true },
        } },
      ] }, render: (_args, observation) => [{ type: 'text', text: JSON.stringify(observation) }],
      presentationMeta: (_args, observation) => ({ devicePreview: observation }) },
      projectContent(execution, outcome) {
        const prepared = projections.get(execution)
        return prepared !== undefined && JSON.stringify(outcome.value) === prepared.receipt ? prepared.content : undefined
      },
      execute(args, execution) {
        argumentsOnly(args, ['previewId', 'slot', 'operation'])
        const request: ObservationRequest = { ...args, previewId: uuid(args.previewId) as DevicePreviewId }
        return run(execution, invocation => observe(request, execution, invocation))
      },
      presentCall: args => ({ card: 'generic', title: `Read device preview ${args.operation}: ${args.slot}`, kind: 'read' }),
    }))
    scope.tools.register(defineTool({
      name: 'device_preview_stop',
      description: 'Stop only the owned managed launcher recorded under a projectId returned by device_preview_project and started by device_preview_open. Waits for that managed process range to stop. Never stops external servers or accepts a PID, port or URL. Closing a preview alone does not stop its launcher.',
      parameters: { projectId: { type: 'string', required: true, description: 'Exact recorded projectId of the owned launcher to stop.' } },
      output: { schema: { type: 'object', additionalProperties: false, properties: {
        kind: { type: 'string', const: 'stopped', required: true }, projectId: { type: 'string', required: true },
      } }, render: (_args, stopped) => [{ type: 'text', text: JSON.stringify(stopped) }],
      presentationMeta: (_args, stopped) => ({ devicePreview: stopped }) },
      execute(args, execution) {
        argumentsOnly(args, ['projectId'])
        const projectId = uuid(args.projectId)
        return run(execution, () => controller.stop(projectId))
      },
      presentCall: args => ({ card: 'generic', title: 'Stop owned device preview launcher', kind: 'execute', rawInput: args.projectId }),
    }))
  })
}
