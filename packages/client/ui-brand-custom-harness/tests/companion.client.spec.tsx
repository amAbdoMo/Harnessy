// @vitest-environment jsdom
/** Native companion request ownership and localized status-only presentation. */
import { useSyncExternalStore } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { CompanionController, type NativeCompanion, type NativeCompanionStatus } from '../src/client/companion.ts'
import { CompanionRow, type CompanionRowProps } from '../src/client/CompanionRow.tsx'
import { en, zh } from '../src/client/locales.ts'
import { slotTestProps } from './slot-test-props.ts'

const INITIAL: NativeCompanionStatus = { available: true, connected: false, pairedCount: 0 }
const PAIRED: NativeCompanionStatus = { available: true, connected: true, pairedCount: 1 }
const PRIVATE_ERROR = 'native private failure details'

afterEach(cleanup)

function controllerFor(native: NativeCompanion): CompanionController {
  const controller = new CompanionController(native)
  onTestFinished(() => { controller.dispose() })
  return controller
}

describe('native companion lifecycle', () => {
  it('shares overlapping reads and publishes immutable copies of only public fields', async () => {
    const read = Promise.withResolvers<NativeCompanionStatus>()
    const native = { describe: vi.fn(() => read.promise), open: vi.fn(async () => {}) }
    const controller = controllerFor(native)
    const first = controller.describe()
    onTestFinished(async () => { read.resolve(INITIAL); await first })
    expect(controller.describe()).toBe(first)
    expect(native.describe).toHaveBeenCalledOnce()
    const response = { ...PAIRED, privateDetail: PRIVATE_ERROR }
    read.resolve(response)
    await first
    const snapshot = controller.state.getSnapshot()
    expect(snapshot).toEqual({ status: PAIRED })
    expect(Object.isFrozen(snapshot)).toBe(true)
    expect(Object.isFrozen(snapshot.status)).toBe(true)
    response.pairedCount = 99
    expect(controller.state.getSnapshot()).toBe(snapshot)
    expect(snapshot.status?.pairedCount).toBe(1)
    await controller.describe()
    expect(native.describe).toHaveBeenCalledTimes(2)
  })

  it.each(['throw', 'reject'] as const)('retains status after an open %s and permits a new dialog attempt', async (failure) => {
    const open = vi.fn<NativeCompanion['open']>(async () => {})
    open.mockImplementationOnce(() => {
      if (failure === 'throw') throw new Error(PRIVATE_ERROR)
      return Promise.reject(new Error(PRIVATE_ERROR))
    })
    const native = { describe: vi.fn(async () => INITIAL), open }
    const controller = controllerFor(native)
    await controller.describe()
    const status = controller.state.getSnapshot().status
    await controller.open()
    expect(controller.state.getSnapshot()).toEqual({ status: INITIAL, error: 'open' })
    expect(controller.state.getSnapshot().status).toBe(status)
    expect(native.describe).toHaveBeenCalledOnce()
    await controller.open()
    expect(controller.state.getSnapshot()).toEqual({ status: INITIAL })
    expect(open).toHaveBeenCalledTimes(2)
    expect(native.describe).toHaveBeenCalledTimes(2)
  })

  it('retains the actual last status when the read after dialog completion fails', async () => {
    const description = vi.fn<NativeCompanion['describe']>()
      .mockResolvedValueOnce(INITIAL)
      .mockRejectedValueOnce(new Error(PRIVATE_ERROR))
      .mockResolvedValueOnce(PAIRED)
    const controller = controllerFor({ describe: description, open: async () => {} })
    await controller.describe()
    await controller.open()
    expect(controller.state.getSnapshot()).toEqual({ status: INITIAL, error: 'read' })
    await controller.describe()
    expect(controller.state.getSnapshot()).toEqual({ status: PAIRED })
  })

  it('shares one dialog request with refresh callers until its final status read settles', async () => {
    const dialog = Promise.withResolvers<undefined>()
    const read = Promise.withResolvers<NativeCompanionStatus>()
    const native = { describe: vi.fn(() => read.promise), open: vi.fn(() => dialog.promise) }
    const controller = controllerFor(native)
    const first = controller.open()
    onTestFinished(async () => { dialog.resolve(undefined); read.resolve(PAIRED); await first })
    expect(controller.open()).toBe(first)
    expect(controller.describe()).toBe(first)
    expect(native.open).toHaveBeenCalledOnce()
    expect(native.describe).not.toHaveBeenCalled()
    dialog.resolve(undefined)
    await dialog.promise
    expect(native.describe).toHaveBeenCalledOnce()
    expect(controller.state.getSnapshot().busy).toBe('open')
    expect(controller.describe()).toBe(first)
    read.resolve(PAIRED)
    await first
    expect(controller.state.getSnapshot()).toEqual({ status: PAIRED })
  })

  it.each(['read', 'open'] as const)('drops late %s results and prevents calls after disposal', async (operation) => {
    const pending = Promise.withResolvers<NativeCompanionStatus>()
    const native = {
      describe: vi.fn(() => pending.promise),
      open: vi.fn(async () => { await pending.promise }),
    }
    const controller = controllerFor(native)
    const request = operation === 'read' ? controller.describe() : controller.open()
    onTestFinished(async () => { pending.resolve(PAIRED); await request })
    const before = controller.state.getSnapshot()
    controller.dispose()
    pending.resolve(PAIRED)
    await request
    expect(controller.state.getSnapshot()).toBe(before)
    await controller.describe()
    await controller.open()
    expect(native.describe).toHaveBeenCalledTimes(operation === 'read' ? 1 : 0)
    expect(native.open).toHaveBeenCalledTimes(operation === 'open' ? 1 : 0)
  })
})

it.each([['English', en], ['Chinese', zh]] as const)('renders %s native status and safe inline dialog failure', async (_language, dictionary) => {
  const controller = controllerFor({
    describe: async () => ({ available: false, connected: false, pairedCount: 0 }),
    open: async () => { throw new Error(PRIVATE_ERROR) },
  })
  const useCompanion: CompanionRowProps['useCompanion'] = selector => selector(useSyncExternalStore(
    listener => controller.state.subscribe(listener), () => controller.state.getSnapshot(),
  ))
  const t = (key: keyof typeof en, params?: Record<string, string | number>): string =>
    dictionary[key].replace('{count}', String(params?.count))
  const props = slotTestProps<CompanionRowProps>({
    useCompanion, t, describe: () => controller.describe(), open: () => controller.open(),
  })
  render(<CompanionRow {...props} />)
  await act(async () => { await controller.describe() })
  screen.getByRole('region', { name: dictionary.companionTitle })
  expect(screen.getByRole('status').textContent).toBe(dictionary.companionUnavailable)
  screen.getByText(dictionary.companionPairedCount.replace('{count}', '0'))
  screen.getByText(dictionary.companionDescription)
  screen.getByText(dictionary.companionPairing)
  screen.getByText(dictionary.companionAuthority)
  screen.getByText(dictionary.companionKeepAwake)
  screen.getByRole('button', { name: dictionary.companionRefresh })
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: dictionary.companionOpen })) })
  expect(screen.getByRole('alert').textContent).toBe(dictionary.companionOpenFailed)
  expect(document.body.textContent).not.toContain(PRIVATE_ERROR)
  expect(screen.queryByRole('link')).toBeNull()
})
