// @vitest-environment jsdom
import type { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mountApprovalPanel, CommandDetail, InputDetail } from './approval-panel-runtime.tsx'
import { PendingApproval } from '../src/client/contract/slots.ts'
import { inject } from '../src/client/index.ts'
import { apply as nodeApply } from '../src/index.ts'

const id = (value: string): SessionId => value as SessionId

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('PendingApproval', () => {
  it('resolves once, removes its abort listener, and ignores later abort cleanup', async () => {
    const controller = new AbortController()
    const remove = vi.spyOn(controller.signal, 'removeEventListener')
    const pending = new PendingApproval(id('s1'), {
      toolName: 'bash',
      callId: 'call-1' as ToolCallId,
      reason: 'needs access',
      detailMode: 'summary-only',
      signal: controller.signal,
    })

    await pending.answer('allowed-once')

    await expect(pending.result).resolves.toBe('allowed-once')
    expect(pending.sessionId).toBe(id('s1'))
    expect(pending.toolName).toBe('bash')
    expect(pending.callId).toBe('call-1')
    expect(pending.reason).toBe('needs access')
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function))
    expect(() => { pending.abort(new Error('late')) }).not.toThrow()
    expect(() => { pending.delegate() }).not.toThrow()
    await expect(pending.answer('rejected')).rejects.toThrow(/already settled/)
  })

  it('rejects with an already-aborted signal reason', async () => {
    const controller = new AbortController()
    const reason = new Error('host cancelled')
    controller.abort(reason)

    const pending = new PendingApproval(id('s1'), {
      toolName: 'read',
      signal: controller.signal,
    })

    await expect(pending.result).rejects.toBe(reason)
  })

  it('uses a stable fallback when an abort signal supplies no reason', async () => {
    const controller = new AbortController()
    controller.abort()
    const signal = controller.signal
    // Exercise a platform signal whose optional cancellation reason is absent.
    vi.spyOn(signal, 'reason', 'get').mockReturnValue(undefined)

    const pending = new PendingApproval(id('s1'), { toolName: 'read', signal })

    await expect(pending.result).rejects.toThrow('approval request was aborted')
  })

  it('rejects an unanswered request explicitly without an AbortSignal', async () => {
    const pending = new PendingApproval(id('s1'), { toolName: 'write' })
    const reason = new Error('scope released')

    pending.abort(reason)

    await expect(pending.result).rejects.toBe(reason)
  })

  it('wraps a non-Error answer settlement failure with its cause', async () => {
    const failure = 'resolve failed'
    const completion = Promise.withResolvers<'allowed-once' | 'rejected'>()
    const withResolvers = vi.spyOn(Promise, 'withResolvers').mockImplementationOnce(() => ({
      promise: completion.promise,
      resolve: () => { throw failure },
      reject: completion.reject,
    }))
    const pending = new PendingApproval(id('s1'), { toolName: 'write' })
    withResolvers.mockRestore()

    const settlement = await pending.answer('allowed-once').catch((error: unknown) => error)

    expect(settlement).toBeInstanceOf(Error)
    expect(settlement).toMatchObject({
      message: 'pending approval settlement failed',
      cause: failure,
    })
    completion.resolve('allowed-once')
    await expect(pending.result).resolves.toBe('allowed-once')
  })
})

describe('ApprovalPanel', () => {
  it('renders fallback copy without detail and returns rejection', async () => {
    const pending = new PendingApproval(id('s1'), { toolName: 'bash' })
    await mountApprovalPanel(pending)

    expect(screen.getByText('Tool bash requests privileged execution')).toBeTruthy()
    expect(document.querySelector('[data-approval-key] [data-state="warning"]')).not.toBeNull()
    expect(screen.getByRole('group', { name: 'Approval details' })).toBeTruthy()
    expect(screen.queryByText('pnpm test')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Reject' }))

    expect(document.querySelector('[data-approval-key]')?.getAttribute('aria-busy')).toBe('true')
    await expect(pending.result).resolves.toBe('rejected')
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Reject' }).disabled).toBe(true)
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Allow once' }).disabled).toBe(true)
  })

  it('renders correlated detail and returns allow-once', async () => {
    const pending = new PendingApproval(id('s1'), {
      toolName: 'bash',
      callId: 'call-1' as ToolCallId,
      reason: 'Run this exact command',
    })
    await mountApprovalPanel(pending, CommandDetail)

    expect(screen.getByText('Run this exact command')).toBeTruthy()
    expect(screen.getByText('pnpm test')).toBeTruthy()
    expect(screen.getByText('pnpm test').getAttribute('data-call-id')).toBe('call-1')
    fireEvent.click(screen.getByRole('button', { name: 'Allow once' }))
    expect(document.querySelector('[data-approval-key] [data-state="ongoing"]')).not.toBeNull()
    expect(document.querySelector('[data-approval-key]')?.getAttribute('aria-busy')).toBe('true')

    await expect(pending.result).resolves.toBe('allowed-once')
  })

  it('keeps the audit reason intact and follows the UI language for presentation copy', async () => {
    const pending = new PendingApproval(id('s1'), {
      toolName: 'bash',
      reason: 'audit reason',
      displayReason: { en: 'English explanation', zh: '中文说明' },
    })
    const view = await mountApprovalPanel(pending)
    expect(screen.getByText('English explanation')).toBeTruthy()
    expect(screen.queryByText('audit reason')).toBeNull()
    await view.setLocale('zh')
    expect(screen.getByText('中文说明')).toBeTruthy()
    expect(pending.reason).toBe('audit reason')
  })

  it.each([['Enter', 'allowed-once'], ['Escape', 'rejected']] as const)(
    'answers the focused container with %s through the pending request', async (key, outcome) => {
      const pending = new PendingApproval(id('s1'), { toolName: 'bash' })
      await mountApprovalPanel(pending)
      const group = screen.getByRole('group', { name: 'Approval details' })
      group.focus()
      const bubbled = vi.fn()
      window.addEventListener('keydown', bubbled)
      try {
        fireEvent.keyDown(group, { key, code: key })
        await expect(pending.result).resolves.toBe(outcome)
        expect(bubbled).not.toHaveBeenCalled()
        expect(pending.answerable).toBe(false)
      } finally { window.removeEventListener('keydown', bubbled) }
    },
  )

  it('leaves button Enter to its native click and rejects from the reject button', async () => {
    const pending = new PendingApproval(id('s1'), { toolName: 'bash' })
    await mountApprovalPanel(pending)
    const reject = screen.getByRole('button', { name: 'Reject' })
    reject.focus()
    expect(fireEvent.keyDown(reject, { key: 'Enter', code: 'Enter' })).toBe(true)
    expect(pending.answerable).toBe(true)
    // jsdom does not synthesize the browser's native button activation.
    fireEvent.click(reject)
    await expect(pending.result).resolves.toBe('rejected')
  })

  it('ignores unowned input, modified keys, repeats and IME candidate keys', async () => {
    const pending = new PendingApproval(id('s1'), { toolName: 'bash', callId: 'call-1' as ToolCallId })
    await mountApprovalPanel(pending, InputDetail)
    const group = screen.getByRole('group', { name: 'Approval details' })
    fireEvent.keyDown(group, { key: 'Enter', code: 'Enter' })
    expect(pending.answerable).toBe(true)
    const input = screen.getByRole('textbox', { name: 'Approval input' })
    input.focus()
    fireEvent.keyDown(input, { key: 'Enter', code: 'Enter' })
    fireEvent.keyDown(input, { key: 'Escape', code: 'Escape' })
    group.focus()
    expect(fireEvent.keyDown(group, { key: 'Tab', code: 'Tab' })).toBe(true)
    fireEvent.keyDown(group, { key: 'Enter', code: 'Enter', ctrlKey: true })
    fireEvent.keyDown(group, { key: 'Escape', code: 'Escape', repeat: true })
    fireEvent.keyDown(group, { key: 'Enter', code: 'Enter', isComposing: true })
    fireEvent.keyDown(group, { key: 'Enter', code: 'Enter', keyCode: 229 })
    fireEvent.compositionStart(group)
    fireEvent.keyDown(group, { key: 'Enter', code: 'Enter' })
    fireEvent.compositionEnd(group)
    fireEvent.keyDown(group, { key: 'Escape', code: 'Escape' })
    expect(pending.answerable).toBe(true)
    fireEvent.keyUp(group, { key: 'Escape', code: 'Escape' })
    fireEvent.keyDown(group, { key: 'Enter', code: 'Enter' })
    await expect(pending.result).resolves.toBe('allowed-once')
  })

  it('locks keyboard and click submissions synchronously while the answer is pending', async () => {
    const pending = new PendingApproval(id('s1'), { toolName: 'bash' })
    const gate = Promise.withResolvers<undefined>()
    const answer = vi.spyOn(pending, 'answer').mockImplementation(() => gate.promise)
    await mountApprovalPanel(pending)
    const group = screen.getByRole('group', { name: 'Approval details' })
    group.focus()
    fireEvent.keyDown(group, { key: 'Enter', code: 'Enter' })
    fireEvent.keyDown(group, { key: 'Escape', code: 'Escape' })
    fireEvent.click(screen.getByRole('button', { name: 'Reject' }))
    expect(answer).toHaveBeenCalledExactlyOnceWith('allowed-once')
    await act(async () => { gate.resolve(undefined); await gate.promise })
    pending.abort(new Error('test cleanup'))
    await pending.result.catch(() => {})
  })

  it('does not settle an aborted request or let its late rejection unlock its replacement', async () => {
    const first = new PendingApproval(id('s1'), { toolName: 'bash' })
    const gate = Promise.withResolvers<undefined>()
    vi.spyOn(first, 'answer').mockImplementation(() => gate.promise)
    const view = await mountApprovalPanel(first)
    let group = screen.getByRole('group', { name: 'Approval details' })
    group.focus()
    fireEvent.keyDown(group, { key: 'Enter', code: 'Enter' })
    first.abort(new Error('request withdrawn'))
    await first.result.catch(() => {})
    const second = new PendingApproval(id('s1'), { toolName: 'read' })
    await view.replace(second)
    await act(async () => { gate.reject(new Error('late transport failure')); await gate.promise.catch(() => {}) })
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Reject' }).disabled).toBe(false)
    second.abort(new Error('request withdrawn'))
    await second.result.catch(() => {})
    const answer = vi.spyOn(second, 'answer')
    group = screen.getByRole('group', { name: 'Approval details' })
    group.focus()
    fireEvent.keyDown(group, { key: 'Enter', code: 'Enter' })
    fireEvent.click(screen.getByRole('button', { name: 'Reject' }))
    expect(answer).not.toHaveBeenCalled()
  })

  it('re-enables actions when answering fails', async () => {
    const pending = new PendingApproval(id('s1'), { toolName: 'bash' })
    vi.spyOn(pending, 'answer').mockRejectedValue(new Error('transport closed'))
    await mountApprovalPanel(pending)

    fireEvent.click(screen.getByRole('button', { name: 'Allow once' }))
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Allow once' }).disabled).toBe(true)
    await waitFor(() => {
      expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Allow once' }).disabled).toBe(false)
    })
    expect(document.querySelector('[data-approval-key]')?.getAttribute('aria-busy')).toBe('false')
    pending.abort(new Error('test cleanup'))
    await pending.result.catch(() => {})
  })
})

describe('package entries', () => {
  it('declares its service edges and keeps the Host half inert', () => {
    expect(inject).toEqual(['sessions', 'remote', 'uiSession', 'slots', 'locale', 'uiConversation'])
    expect(() => { nodeApply() }).not.toThrow()
  })
})
