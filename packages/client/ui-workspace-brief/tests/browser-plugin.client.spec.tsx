// @vitest-environment jsdom
import { Context } from '@deepseek-ai/cordis'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { WorkspaceBriefCard, type WorkspaceBriefCardProps } from '../src/client/WorkspaceBriefCard.tsx'
import { apply, inject } from '../src/client/index.ts'

const translations: Record<string, string> = {
  'card.title': 'Workspace Brief',
  'card.running': 'Running…',
  'card.failed': 'Failed',
  'markdown.copy': 'Copy code',
  'markdown.copied': 'Copied',
  'markdown.footnotes': 'Footnotes',
}

const t = (key: string): string => translations[key] ?? key
const sid = (value: string): SessionId => value as SessionId

function cardProps(outcome: { kind: 'success' | 'error'; text?: string } | null): WorkspaceBriefCardProps {
  return {
    node: {
      kind: 'command',
      seq: 1,
      time: 1,
      commandId: 'brief-command',
      name: 'workspace-brief',
      args: '',
      outcome,
    },
    sessionId: sid('s1'),
    t,
  } as WorkspaceBriefCardProps
}

afterEach(() => { cleanup() })

describe('WorkspaceBriefCard', () => {
  it('renders running, durable Markdown success, and durable error states', () => {
    const running = render(<WorkspaceBriefCard {...cardProps(null)} />)
    expect(screen.getByRole('status').textContent).toContain('Running…')
    running.unmount()

    const success = render(<WorkspaceBriefCard {...cardProps({
      kind: 'success', text: '# Workspace Brief\n\n- Branch: `main`',
    })} />)
    expect(screen.getByRole('heading', { name: 'Workspace Brief' })).toBeDefined()
    expect(screen.getByText('main')).toBeDefined()
    success.unmount()

    render(<WorkspaceBriefCard {...cardProps({ kind: 'error', text: 'not a Git repository' })} />)
    expect(screen.getByRole('status').textContent).toContain('Failed')
    expect(screen.getByText('not a Git repository')).toBeDefined()
  })
})

describe('ui-workspace-brief plugin lifecycle', () => {
  it('keeps the durable card without a header action and withdraws it on disable', async () => {
    const ctx = new Context()
    try {
      await ctx.plugin(SlotRegistry).await()
      ctx.slots.register({
        name: 'root',
        children: {
          'conversation.session.header.actions': { kind: 'list', scope: 'session' },
          'conversation.chat.commandview': { kind: 'keyed', scope: 'session' },
        },
      } as never, (() => null) as never)
      ctx.provide('locale', new LocaleRuntime(ctx))
      const fiber = ctx.plugin({ inject: [...inject], apply })
      await fiber.await()
      expect(ctx.slots.entries('conversation.session.header.actions')).toHaveLength(0)
      const card = ctx.slots.entries('conversation.chat.commandview')[0]
      expect(card?.options).toMatchObject({ key: 'workspace-brief' })
      expect(card?.locale).toBe('workspaceBrief')

      await fiber.dispose()
      expect(ctx.slots.entries('conversation.chat.commandview')).toHaveLength(0)
      const reloaded = ctx.plugin({ inject: [...inject], apply })
      await reloaded.await()
      expect(ctx.slots.entries('conversation.session.header.actions')).toHaveLength(0)
      expect(ctx.slots.entries('conversation.chat.commandview')).toHaveLength(1)
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
