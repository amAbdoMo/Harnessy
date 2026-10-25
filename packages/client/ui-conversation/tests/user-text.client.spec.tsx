// @vitest-environment jsdom
/** Matching failure retains authoritative text until its dependency becomes available. */
import { Context } from '@deepseek-ai/cordis'
import { cleanup, render } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { afterEach, expect, it, onTestFinished, vi } from 'vitest'
import { UserText } from '../src/client/user-text/UserText.tsx'
import { UserTextRegistry } from '../src/client/conversation/user-text-registry.ts'

afterEach(cleanup)

it('retains complete original text, reports a cached matching failure once, and recovers', () => {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  const registry = new UserTextRegistry(ctx)
  const cause = new Error('matching unavailable')
  registry.register({ id: 'session', order: 0, match: (text, from, context) => {
    if (from > 0) return undefined
    if (context.read('sessionLabels') === undefined) throw cause
    return { id: 'session', start: 0, end: text.length, data: { label: 'ready' } }
  } })
  const evaluate = registry.createEvaluator()
  const report = vi.fn()
  const renderSlot = vi.fn(() => <span>recognized output</span>)
  const text = '  complete /original\n@reference  '
  const props = {
    text, facts: {}, createUserTextEvaluator: () => evaluate,
    useUserTextRevision: selector => selector(registry.getSnapshot()),
    reportTransformFailure: report, renderSlot,
  } satisfies Partial<ComponentProps<typeof UserText>>
  const view = render(<UserText {...props as ComponentProps<typeof UserText>} />)
  expect(view.container.textContent).toBe(text)
  expect(renderSlot).not.toHaveBeenCalled()
  expect(report).toHaveBeenCalledOnce()
  expect(report.mock.calls[0]?.[0]).toMatchObject({ ruleId: 'session', cause })
  view.rerender(<UserText {...props as ComponentProps<typeof UserText>} facts={{ collapseWhitespace: false }} />)
  expect(view.container.textContent).toBe(text)
  expect(report).toHaveBeenCalledOnce()
  view.rerender(<UserText {...props as ComponentProps<typeof UserText>} facts={{ sessionLabels: ['ready'] }} />)
  expect(view.getByText('recognized output')).toBeTruthy()
  expect(renderSlot).toHaveBeenCalledOnce()
  expect(report).toHaveBeenCalledOnce()
})
