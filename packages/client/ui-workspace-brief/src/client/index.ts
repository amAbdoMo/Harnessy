/** Harnessy browser UI for the `/workspace-brief` host command. */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { CommandResult } from '@deepseek-ai/dsh-commands'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-chat/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import { WorkspaceBriefAction } from './WorkspaceBriefAction.tsx'
import { WorkspaceBriefCard } from './WorkspaceBriefCard.tsx'
import { en, NS, zh, type WorkspaceBriefKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Workspace Brief action and durable result-card copy. */
    workspaceBrief: WorkspaceBriefKey
  }
}

/** Host command operation supplied to the Workspace Brief header action. */
export interface WorkspaceBriefActionInjected {
  /** Execute the host command once; transport and command failures reject. */
  createBrief: () => Promise<void>
}

export const inject = ['slots', 'remote', 'remote.commands', 'locale']

function commandFailure(result: CommandResult | undefined, unavailable: string): Error | undefined {
  if (result === undefined) return new Error(unavailable)
  return result.kind === 'error' ? new Error(result.text) : undefined
}

/** Register one header action and one command-name-keyed Markdown card. */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-workspace-brief: dictionaries')

  ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({
    name: 'conversation.session.header.actions',
    id: 'workspace-brief',
    order: 30,
    locale: NS,
    inject: (sessionId: SessionId): WorkspaceBriefActionInjected => ({
      createBrief: async () => {
        const response = await ctx.remote.commands.execute(sessionId, '/workspace-brief', [])
        if (!response.ok) throw new Error(`${response.error.message} (${response.error.code})`)
        const failure = commandFailure(response.value?.result, ctx.locale.bind(NS)('action.unavailable'))
        if (failure !== undefined) throw failure
      },
    }),
  }, WorkspaceBriefAction))

  ctx.slots.inject('conversation.chat.commandview', () => ctx.slots.register({
    name: 'conversation.chat.commandview',
    key: 'workspace-brief',
    locale: NS,
  }, WorkspaceBriefCard))
}
