/** Harnessy browser result card for the `/workspace-brief` host command. */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-chat/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { WorkspaceBriefCard } from './WorkspaceBriefCard.tsx'
import { en, NS, type WorkspaceBriefKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Workspace Brief durable result-card copy. */
    workspaceBrief: WorkspaceBriefKey
  }
}

export const inject = ['slots', 'locale']

/** Register the command-name-keyed Markdown result card. */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { en }), 'ui-workspace-brief: dictionaries')
  ctx.slots.inject('conversation.chat.commandview', () => ctx.slots.register({
    name: 'conversation.chat.commandview',
    key: 'workspace-brief',
    locale: NS,
  }, WorkspaceBriefCard))
}
