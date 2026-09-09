// @vitest-environment jsdom
import { Context, Service } from '@deepseek-ai/cordis'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WorkspaceBriefAction, type WorkspaceBriefActionProps } from '../src/client/WorkspaceBriefAction.tsx'
import { WorkspaceBriefCard, type WorkspaceBriefCardProps } from '../src/client/WorkspaceBriefCard.tsx'
import { apply, inject, type WorkspaceBriefActionInjected } from '../src/client/index.ts'

const translations: Record<string, string> = {
  'action.idle': 'Create workspace brief',
  'action.loading': 'Creating brief…',
  'action.success': 'Brief created',
  'action.failed': 'Brief failed',
  'action.unavailable': 'Workspace Brief is unavailable.',
  'card.title': 'Workspace Brief',
  'card.running': 'Running…',
  'card.failed': 'Failed',
  'markdown.copy': 'Copy code',
  'markdown.copied': 'Copied',
  'markdown.footnotes': 'Footnotes',
}

const t = (key: string): string => translations[key] ?? key
const sid = (value: string): SessionId => value as SessionId

function actionProps(
  createBrief: () => Promise<void>,
  openState: 'closed' | 'opening' | 'open' = 'open',
): WorkspaceBriefActionProps {
  return {
    createBrief,
    useSession: (selector: (snapshot: { openState: string }) => unknown) => selector({ openState }),
    sessionId: sid('s1'),
    t,
  } as unknown as WorkspaceBriefActionProps
}

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
  } as unknown as WorkspaceBriefCardProps
}

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('WorkspaceBriefAction', () => {
  it('disables without an open session and never dispatches', () => {
    const createBrief = vi.fn(async () => undefined)
    render(<WorkspaceBriefAction {...actionProps(createBrief, 'closed')} />)
    const button = screen.getByRole('button', { name: 'Create workspace brief' })
    expect((button as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(button)
    expect(createBrief).not.toHaveBeenCalled()
  })

  it('deduplicates an in-flight click and reports success', async () => {
    let settle: (() => void) | undefined
    const createBrief = vi.fn(() => new Promise<void>(resolve => { settle = resolve }))
    render(<WorkspaceBriefAction {...actionProps(createBrief)} />)

    const button = screen.getByRole('button', { name: 'Create workspace brief' })
    fireEvent.click(button)
    fireEvent.click(button)
    expect(createBrief).toHaveBeenCalledTimes(1)
    expect((screen.getByRole('button', { name: 'Creating brief…' }) as HTMLButtonElement).disabled).toBe(true)

    await act(async () => { settle?.(); await Promise.resolve() })
    expect((screen.getByRole('button', { name: 'Brief created' }) as HTMLButtonElement).disabled).toBe(false)
  })

  it('keeps an actionable error visible and allows an explicit retry', async () => {
    const createBrief = vi.fn()
      .mockRejectedValueOnce(new Error('permission denied'))
      .mockResolvedValueOnce(undefined)
    render(<WorkspaceBriefAction {...actionProps(createBrief)} />)

    fireEvent.click(screen.getByRole('button', { name: 'Create workspace brief' }))
    expect((await screen.findByRole('status')).textContent).toContain('permission denied')
    expect(screen.getByRole('button', { name: 'Brief failed' }).getAttribute('title')).toBe('permission denied')

    fireEvent.click(screen.getByRole('button', { name: 'Brief failed' }))
    await screen.findByRole('button', { name: 'Brief created' })
    expect(createBrief).toHaveBeenCalledTimes(2)
  })
})

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

async function pluginBench() {
  const ctx = new Context()
  const calls: Array<{ sessionId: SessionId; command: string; attachments: readonly unknown[] }> = []
  let response: unknown = { ok: true as const, value: { result: { kind: 'success' as const, text: '# Workspace Brief' } } }
  const commands = {
    execute: vi.fn(async (sessionId: SessionId, command: string, attachments: readonly unknown[]) => {
      calls.push({ sessionId, command, attachments })
      return response
    }),
  }
  class RemoteService extends Service {
    constructor(serviceCtx: Context) { super(serviceCtx, 'remote') }
  }
  const remote = new RemoteService(ctx) as RemoteService & { commands: typeof commands }
  remote.commands = commands
  ctx.provide('remote.commands', commands)
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
  return {
    ctx,
    calls,
    fiber,
    setResponse(value: unknown) { response = value },
    actionEntry() {
      return ctx.slots.entries('conversation.session.header.actions')[0]
    },
  }
}

describe('ui-workspace-brief plugin lifecycle', () => {
  it('declares its runtime dependencies and registers both product surfaces', async () => {
    expect(inject).toEqual(['slots', 'remote', 'remote.commands', 'locale'])
    const test = await pluginBench()
    expect(test.actionEntry()?.options).toMatchObject({ id: 'workspace-brief', order: 30 })
    expect(test.actionEntry()?.locale).toBe('workspaceBrief')
    const card = test.ctx.slots.entries('conversation.chat.commandview')[0]
    expect(card?.options).toMatchObject({ key: 'workspace-brief' })
    expect(card?.locale).toBe('workspaceBrief')
  })

  it('dispatches the exact bounded command and rejects transport or command failures', async () => {
    const test = await pluginBench()
    const injectAction = test.actionEntry()?.inject as unknown as ((sessionId: SessionId) => WorkspaceBriefActionInjected)
    const face = injectAction(sid('selected'))
    await expect(face.createBrief()).resolves.toBeUndefined()
    expect(test.calls).toEqual([{ sessionId: 'selected', command: '/workspace-brief', attachments: [] }])

    test.setResponse({ ok: true, value: { result: { kind: 'error', text: 'not a Git repository' } } })
    await expect(face.createBrief()).rejects.toThrow('not a Git repository')
    test.setResponse({ ok: false, error: { code: 'disconnected', message: 'offline' } })
    await expect(face.createBrief()).rejects.toThrow('offline (disconnected)')
  })

  it('withdraws both registrations on disable and re-enables without duplicates', async () => {
    const test = await pluginBench()
    await test.fiber.dispose()
    expect(test.ctx.slots.entries('conversation.session.header.actions')).toHaveLength(0)
    expect(test.ctx.slots.entries('conversation.chat.commandview')).toHaveLength(0)

    const reloaded = test.ctx.plugin({ inject: [...inject], apply })
    await reloaded.await()
    expect(test.ctx.slots.entries('conversation.session.header.actions')).toHaveLength(1)
    expect(test.ctx.slots.entries('conversation.chat.commandview')).toHaveLength(1)
  })
})
