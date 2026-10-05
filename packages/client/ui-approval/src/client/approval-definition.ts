/** Durable approval audit pairs projected as one safe Chat checkpoint. */
import type { ConversationNodeDefinition } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { ApprovalOutcome, ApprovalRequestId } from '@deepseek-ai/dsh-user-approval/types'

/** Audit summary only; correlated Tool arguments are never checkpoint data. */
export interface ApprovalCheckpointData {
  readonly requestId: ApprovalRequestId
  readonly toolName: string
  readonly reason?: string
  readonly status: 'asked' | ApprovalOutcome
}

declare module '@deepseek-ai/dsh-client-ui-chat/client' {
  interface ChatNodeDataMap {
    /** One approval question and its durable permission outcome. */
    'approval-checkpoint': ApprovalCheckpointData
  }
}

/** Incremental fold keyed by the service-issued ApprovalRequestId. */
export const approvalDefinition: ConversationNodeDefinition<ApprovalCheckpointData> = {
  kind: 'approval-checkpoint',
  target: 'chat',
  match: (event) => {
    if (event.type === 'approval/asked') return { id: event.data.id, role: 'start' }
    if (event.type === 'approval/decided') return { id: event.data.id, role: 'update' }
    return null
  },
  start: (_context, { event }) => {
    if (event.type !== 'approval/asked') throw new Error('approval checkpoint requires approval/asked')
    return {
      requestId: event.data.id,
      toolName: event.data.toolName,
      ...(event.data.reason === undefined ? {} : { reason: event.data.reason }),
      status: 'asked',
    }
  },
  update: (context, { event }) => event.type === 'approval/decided'
    ? { ...context.state, status: event.data.outcome }
    : context.state,
  publication: () => 'immediate',
  buildViewNode: (context) => {
    if (context.state === undefined || context.start === undefined) return null
    return {
      key: context.key,
      kind: 'approval-checkpoint',
      id: context.id,
      target: 'chat',
      anchorSeq: context.start.event.seq,
      location: context.start.location,
      visibility: 'visible',
      data: context.state,
    }
  },
}
