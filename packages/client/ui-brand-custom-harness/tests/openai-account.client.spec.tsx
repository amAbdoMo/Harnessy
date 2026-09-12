// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  OpenAIAccountCard, type OpenAIAccountCardProps, type OpenAIAccountOperations,
} from '../src/client/OpenAIAccountCard.tsx'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)

const t = (key: keyof typeof en): string => en[key]

function renderCard(operations: OpenAIAccountOperations) {
  return render(<OpenAIAccountCard {...({ operations, t } as unknown as OpenAIAccountCardProps)} />)
}

async function enabledButton(name: string): Promise<HTMLElement> {
  const button = await screen.findByRole('button', { name })
  await waitFor(() => { expect(button.hasAttribute('disabled')).toBe(false) })
  return button
}

describe('OpenAI account Models card', () => {
  it('signs in through the browser flow and refreshes the visible status', async () => {
    let configured = false
    const signIn = vi.fn<OpenAIAccountOperations['signIn']>(async () => {
      configured = true
      return { authorized: true }
    })
    const operations: OpenAIAccountOperations = {
      describe: vi.fn(async () => ({ state: {
        available: true, configured, inFlight: false, writable: true,
      } })),
      signIn,
      signOut: vi.fn(async () => undefined),
    }
    renderCard(operations)
    const button = await enabledButton(en.openAISignIn)
    fireEvent.click(button)
    screen.getByRole('dialog', { name: en.openAISignInTitle })
    await waitFor(() => { expect(screen.getByText(en.openAIConnected)).not.toBeNull() })
    expect(signIn).toHaveBeenCalledWith(expect.any(AbortSignal))
  })

  it('cancels an in-flight attempt when the dialog closes', async () => {
    let observed: AbortSignal | undefined
    const operations: OpenAIAccountOperations = {
      describe: vi.fn(async () => ({ state: {
        available: true, configured: false, inFlight: false, writable: true,
      } })),
      signIn: vi.fn<OpenAIAccountOperations['signIn']>((signal: AbortSignal) => {
        observed = signal
        return new Promise<{ readonly authorized: boolean }>((resolve) => {
          signal.addEventListener('abort', () => {
            resolve({ authorized: false })
          }, { once: true })
        })
      }),
      signOut: vi.fn(async () => undefined),
    }
    renderCard(operations)
    fireEvent.click(await enabledButton(en.openAISignIn))
    fireEvent.click(screen.getByRole('button', { name: en.cancel }))
    expect(observed?.aborted).toBe(true)
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('signs out and reports Host failures without exposing credential data', async () => {
    const operations: OpenAIAccountOperations = {
      describe: vi.fn(async () => ({ state: {
        available: true, configured: true, inFlight: false, writable: true,
      } })),
      signIn: vi.fn(async () => ({ authorized: false })),
      signOut: vi.fn(async () => 'credential store is read-only'),
    }
    renderCard(operations)
    fireEvent.click(await enabledButton(en.openAISignOut))
    expect(await screen.findByText('credential store is read-only')).not.toBeNull()
  })

  it('reports a sign-in failure and leaves the account disconnected', async () => {
    const operations: OpenAIAccountOperations = {
      describe: vi.fn(async () => ({ state: {
        available: true, configured: false, inFlight: false, writable: true,
      } })),
      signIn: vi.fn(async () => ({ authorized: false, error: 'browser launch failed' })),
      signOut: vi.fn(async () => undefined),
    }
    renderCard(operations)
    fireEvent.click(await enabledButton(en.openAISignIn))
    expect(await screen.findByText('browser launch failed')).not.toBeNull()
    expect(screen.getByText(en.openAINotConnected)).not.toBeNull()
  })

  it('refreshes to disconnected after a successful sign-out', async () => {
    let configured = true
    const release = Promise.withResolvers<undefined>()
    const operations: OpenAIAccountOperations = {
      describe: vi.fn(async () => ({ state: {
        available: true, configured, inFlight: false, writable: true,
      } })),
      signIn: vi.fn(async () => ({ authorized: false })),
      signOut: vi.fn(async () => {
        await release.promise
        configured = false
        return undefined
      }),
    }
    renderCard(operations)
    fireEvent.click(await enabledButton(en.openAISignOut))
    expect(screen.getByRole('button', { name: en.openAISigningOut }).hasAttribute('disabled')).toBe(true)
    release.resolve(undefined)
    await waitFor(() => { expect(screen.getByText(en.openAINotConnected)).not.toBeNull() })
  })

  it('renders unavailable and read-only account states as disabled', async () => {
    const unavailable: OpenAIAccountOperations = {
      describe: vi.fn(async () => ({ state: {
        available: false, configured: false, inFlight: false, writable: false,
      } })),
      signIn: vi.fn(async () => ({ authorized: false })),
      signOut: vi.fn(async () => undefined),
    }
    const view = renderCard(unavailable)
    expect(await screen.findByText(en.openAIUnavailable)).not.toBeNull()
    expect(screen.getByRole('button', { name: en.openAISignIn }).hasAttribute('disabled')).toBe(true)
    view.unmount()

    renderCard({
      ...unavailable,
      describe: vi.fn(async () => ({ state: {
        available: true, configured: false, inFlight: false, writable: false,
      } })),
    })
    expect(await screen.findByText(en.openAINotConnected)).not.toBeNull()
    expect(screen.getByRole('button', { name: en.openAISignIn }).hasAttribute('disabled')).toBe(true)
  })

  it('ignores a late initial state after unmount and aborts an active attempt', async () => {
    const described = Promise.withResolvers<{
      state: { available: true; configured: false; inFlight: false; writable: true }
    }>()
    let signal: AbortSignal | undefined
    const operations: OpenAIAccountOperations = {
      describe: vi.fn(() => described.promise),
      signIn: vi.fn((value: AbortSignal) => {
        signal = value
        return new Promise<{ readonly authorized: boolean }>(() => {})
      }),
      signOut: vi.fn(async () => undefined),
    }
    const view = renderCard(operations)
    described.resolve({ state: {
      available: true, configured: false, inFlight: false, writable: true,
    } })
    fireEvent.click(await enabledButton(en.openAISignIn))
    view.unmount()
    expect(signal?.aborted).toBe(true)

    const late = Promise.withResolvers<Record<string, never>>()
    const lateView = renderCard({ ...operations, describe: vi.fn(() => late.promise) })
    lateView.unmount()
    late.resolve({})
    await Promise.resolve()
  })
})
