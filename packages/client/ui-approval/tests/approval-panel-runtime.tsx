/** ApprovalPanel unit fixture using production slot props and session scope resolution. */
import { useState } from 'react'
import { act } from '@testing-library/react'
import { onTestFinished } from 'vitest'
import { RemoteMock, ok } from '@deepseek-ai/dsh-remote-mock'
import type { ComposerChainProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { PropsRuntime, SlotComponent } from '@deepseek-ai/dsh-client-ui-slots'
import { SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session/types'
import type { SessionFollowFrame, SessionSummary } from '@deepseek-ai/dsh-api-session-controller/types'
import type { SettingsNamespaceView, SettingsPathOpView } from '@deepseek-ai/dsh-settings/types'
import { LocaleSettingsSchema } from '@deepseek-ai/dsh-client-locale/src/locale-settings.ts'
import { ApprovalPanel } from '../src/client/ApprovalPanel.tsx'
import { PendingApproval, type ApprovalInjected } from '../src/client/contract/slots.ts'
import { en, zh } from '../src/client/locales.ts'
import { approvalRuntimePlan, TestClient, remoteDefaultResponses } from './approval-runtime.client.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    'approval.panel-test': {
      kind: 'single'
      scope: 'session'
      owner: ComposerChainProps & { matched: PendingApproval }
    }
  }
}

/**
 * Render the approval detail slot's correlation id.
 * @param props - Renderer-generated detail slot props.
 * @returns Inline detail content carrying the call id.
 */
export function CommandDetail({ callId }: PropsRuntime<'conversation.approval.detail'>) {
  return <code data-call-id={callId}>pnpm test</code>
}

/**
 * Provide a focusable descendant for the approval detail slot.
 * @returns An input with an accessible name for focus assertions.
 */
export function InputDetail() {
  return <input aria-label="Approval input" />
}

/**
 * Mount the panel with renderer-generated hooks, real localization and an opened Session.
 * @param pending - Domain request shown in the test-only single slot.
 * @param Detail - Optional detail component registered under the production child slot.
 * The fixture releases its renderer, Session and client at test completion, including setup failures.
 * @returns Controls for owner updates and the real locale service.
 */
export async function mountApprovalPanel(
  pending: PendingApproval,
  Detail: SlotComponent<PropsRuntime<'conversation.approval.detail'>> = CommandDetail,
) {
  const language = document.documentElement.getAttribute('lang')
  const mock = RemoteMock.create().load(remoteDefaultResponses)
  const summary: SessionSummary = {
    sessionId: pending.sessionId, agentAvailable: false, updatedAt: 1, running: false, blank: true,
  }
  mock.unary('session/list', ok({ items: [summary] }))
  mock.unary('session/projections', ok({ asOfSeq: -1, values: {} }))
  let settingsRevision = 0
  mock.unary<[string, readonly SettingsPathOpView[], number?]>('settings/mutate', (ns, ops) => {
    const value: Record<string, string> = {}
    for (const op of ops) {
      if (op.op === 'set' && op.path[0] === 'preference' && typeof op.value === 'string') {
        value.preference = op.value
      }
    }
    const view: SettingsNamespaceView = {
      ns, autoGenerate: false,
      schema: JSON.parse(JSON.stringify(LocaleSettingsSchema.toJSON())) as SettingsNamespaceView['schema'],
      value,
      applies: 'live', secrets: [], revision: ++settingsRevision,
    }
    return ok(view)
  })
  const opening: SessionFollowFrame = {
    type: 'snapshot',
    header: { version: SESSION_FORMAT_VERSION, id: pending.sessionId, createdAt: 1, isSeeded: false },
    cursor: -1,
    records: [],
    hasMore: false,
    projections: { asOfSeq: -1, values: {} },
    assistantStream: { revision: 0 },
  }
  mock.stream('session/follow', (_args, stream) => { stream.push(opening) })
  const requests = new Set([pending])
  const container = document.createElement('div')
  document.body.appendChild(container)
  const cleanup: {
    unmount?: () => void
    release?: () => void
    dispose?: () => Promise<void>
  } = {}
  onTestFinished(async () => {
    try {
      await act(async () => {
        cleanup.unmount?.()
        cleanup.release?.()
        for (const request of requests) {
          request.abort(new Error('panel fixture disposed'))
          await request.result.catch(() => undefined)
        }
        await cleanup.dispose?.()
      })
    } finally {
      container.remove()
      if (language === null) document.documentElement.removeAttribute('lang')
      else document.documentElement.setAttribute('lang', language)
    }
  })
  const client = await TestClient.start(approvalRuntimePlan, mock)
  cleanup.dispose = () => client.dispose()
  client.ctx.locale.setLocale('en')
  client.ctx.effect(() => client.ctx.locale.register('approval', { en, zh }))
  await client.ctx.sessions.refresh()
  const reference = client.ctx.sessions.retain(pending.sessionId, { source: 'controllerOperation' })
  cleanup.release = () => { reference.release() }
  await reference.ready
  let replace: ((next: PendingApproval) => void) | undefined
  client.ctx.effect(() => client.ctx.slots.register({
    name: 'root',
    priority: -100,
    children: { 'approval.panel-test': { kind: 'single', scope: 'session' } },
  }, ({ renderSlot, SessionProvider }) => {
    const [current, setCurrent] = useState(pending)
    replace = setCurrent
    return <SessionProvider session={reference}>
      {renderSlot('approval.panel-test', {
        matched: current,
        pendingInteraction: current,
        sessionId: current.sessionId,
        session: undefined,
      })}
    </SessionProvider>
  }))
  client.ctx.effect(() => client.ctx.slots.register({
    name: 'approval.panel-test',
    locale: 'approval',
    inject: (): ApprovalInjected => ({
      resolveReason: reason => client.ctx.locale.resolveText(reason),
    }),
    children: { 'conversation.approval.detail': { kind: 'single', scope: 'session' } },
  }, ApprovalPanel))
  client.ctx.effect(() => client.ctx.slots.register({ name: 'conversation.approval.detail' }, Detail))
  await act(async () => { cleanup.unmount = client.ctx.uiRenderer.mount(container) })
  return {
    async replace(next: PendingApproval): Promise<void> {
      requests.add(next)
      if (replace === undefined) throw new Error('panel owner is not mounted')
      await act(async () => { replace?.(next) })
    },
    async setLocale(languageId: string): Promise<void> {
      await act(async () => { client.ctx.locale.setLocale(languageId) })
    },
  }
}
