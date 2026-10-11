// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useBillingDay } from '../src/client/billing-reminder-clock.ts'

function Day({ enabled }: { readonly enabled: boolean }) {
  return <output>{useBillingDay(enabled)}</output>
}

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('billing reminder local calendar clock', () => {
  it('updates at local midnight and releases its only timeout on unmount', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 9, 16, 23, 59, 59))
    const rendered = render(<Day enabled />)
    expect(screen.getByText('2026-10-16')).toBeTruthy()
    expect(vi.getTimerCount()).toBe(1)
    act(() => { vi.advanceTimersByTime(1000) })
    expect(screen.getByText('2026-10-17')).toBeTruthy()
    expect(vi.getTimerCount()).toBe(1)
    rendered.unmount()
    expect(vi.getTimerCount()).toBe(0)
    fireEvent(window, new Event('focus'))
    expect(vi.getTimerCount()).toBe(0)
  })

  it('catches up on foreground return and owns no timer while disabled', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 9, 16, 12))
    const rendered = render(<Day enabled={false} />)
    expect(vi.getTimerCount()).toBe(0)
    vi.setSystemTime(new Date(2028, 2, 18, 12))
    rendered.rerender(<Day enabled />)
    expect(screen.getByText('2028-03-18')).toBeTruthy()
    vi.setSystemTime(new Date(2028, 2, 19, 12))
    fireEvent(document, new Event('visibilitychange'))
    expect(screen.getByText('2028-03-19')).toBeTruthy()
    vi.setSystemTime(new Date(2028, 2, 20, 12))
    fireEvent(window, new Event('focus'))
    expect(screen.getByText('2028-03-20')).toBeTruthy()
    rendered.rerender(<Day enabled={false} />)
    expect(vi.getTimerCount()).toBe(0)
  })
})
