// @vitest-environment jsdom
import { useSyncExternalStore } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import {
  PhoneConnectionRow, PhoneConnectionToast, type PhoneConnectionRowProps, type PhoneConnectionToastProps,
} from '../src/client/PhoneConnectionRow.tsx'
import { PhoneConnectionController, type NativePhoneConnection } from '../src/client/phone-connection.ts'
import { en, zh } from '../src/client/locales.ts'
import { slotTestProps } from './slot-test-props.ts'

const ROOT = 'https://pc.example.ts.net/'
const SECRET_ERROR = 'pairing failed: https://pc.example.ts.net/#secret-pairing-token'

afterEach(cleanup)

function snapshotHook<T>(source: ObservableSnapshot<T>) {
  return <Selected,>(selector: (value: T) => Selected): Selected => selector(useSyncExternalStore(
    listener => source.subscribe(listener), () => source.getSnapshot(),
  ))
}

function mount(native: NativePhoneConnection, dictionary: { [Key in keyof typeof en]: string } = en) {
  const controller = new PhoneConnectionController(native)
  onTestFinished(() => { controller.dispose() })
  const t = (key: keyof typeof en): string => dictionary[key]
  const props = slotTestProps<PhoneConnectionRowProps>({
    usePhoneConnection: snapshotHook(controller.state), t,
    describe: () => controller.describe(), copy: () => controller.copy(),
  })
  const toast = render(<PhoneConnectionToast {...slotTestProps<PhoneConnectionToastProps>({
    usePhoneConnectionNotice: snapshotHook(controller.notice), t,
    dismiss: (id: string) => { controller.dismiss(id) },
  })} />)
  const row = render(<PhoneConnectionRow {...props} />)
  act(() => { void controller.describe() })
  return { controller, row, toast, props }
}

function native(enabled: boolean): NativePhoneConnection {
  return {
    describe: async () => enabled ? { enabled: true, remoteRoot: ROOT } : { enabled: false },
    copyPairingUrl: vi.fn(async () => {}),
  }
}

describe('desktop phone connection presentation', () => {
  it('shares overlapping description requests and permits a fresh read after settlement', async () => {
    const pending = Promise.withResolvers<Awaited<ReturnType<NativePhoneConnection['describe']>>>()
    const describe = vi.fn(() => pending.promise)
    const controller = new PhoneConnectionController({ describe, copyPairingUrl: async () => {} })
    const first = controller.describe()
    onTestFinished(async () => {
      controller.dispose()
      pending.resolve({ enabled: false })
      await first
    })
    const second = controller.describe()
    expect(first).toBe(second)
    expect(describe).toHaveBeenCalledOnce()
    pending.resolve({ enabled: true, remoteRoot: ROOT })
    await first
    expect(controller.state.getSnapshot()).toEqual({ status: 'enabled', remoteRoot: ROOT, copying: false })
    await controller.describe()
    expect(describe).toHaveBeenCalledTimes(2)
  })

  it('shows disabled setup without a copy action or a clipboard call', async () => {
    const carrier = native(false)
    const { controller } = mount(carrier)
    await screen.findByText(en.phoneConnectionDisabled)
    screen.getByText(en.phoneConnectionSetup)
    screen.getByText(en.phoneConnectionPrivateServe)
    expect(screen.queryByRole('button', { name: en.phoneConnectionCopy })).toBeNull()
    await controller.copy()
    expect(carrier.copyPairingUrl).not.toHaveBeenCalled()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('keeps copying single-flight across settings remounts and reports success after settings close', async () => {
    const pending = Promise.withResolvers<undefined>()
    onTestFinished(() => { pending.resolve(undefined) })
    const copyPairingUrl = vi.fn(() => pending.promise)
    const { row, controller, props } = mount({ ...native(true), copyPairingUrl })
    await screen.findByText(ROOT)
    screen.getByText(en.phoneConnectionAccessWarning)
    screen.getByText(en.phoneConnectionClipboardWarning)
    expect(screen.queryByRole('link')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: en.phoneConnectionCopy }))
    expect(screen.getByRole<HTMLButtonElement>('button', { name: en.phoneConnectionCopy }).disabled).toBe(true)
    await controller.copy()
    row.unmount()
    const remounted = render(<PhoneConnectionRow {...props} />)
    expect(screen.getByRole<HTMLButtonElement>('button', { name: en.phoneConnectionCopy }).disabled).toBe(true)
    expect(copyPairingUrl).toHaveBeenCalledOnce()
    remounted.unmount()
    await act(async () => { pending.resolve(undefined); await pending.promise })
    expect(screen.getByRole('alert').textContent).toBe(en.phoneConnectionCopied)
    expect(screen.queryByRole('region')).toBeNull()
    expect(document.body.textContent).not.toContain('secret-pairing-token')
  })

  it.each(['throw', 'reject'] as const)('uses safe copy failure feedback for a native %s and permits retry', async (failure) => {
    const copyPairingUrl = vi.fn<NativePhoneConnection['copyPairingUrl']>(async () => {})
    copyPairingUrl.mockImplementationOnce(() => {
      if (failure === 'throw') throw new Error(SECRET_ERROR)
      return Promise.reject(new Error(SECRET_ERROR))
    })
    mount({ ...native(true), copyPairingUrl })
    await screen.findByText(ROOT)
    fireEvent.click(screen.getByRole('button', { name: en.phoneConnectionCopy }))
    await waitFor(() => { expect(screen.getByRole('alert').textContent).toBe(en.phoneConnectionCopyFailed) })
    expect(screen.getByText(ROOT)).toBeTruthy()
    expect(document.body.textContent).not.toContain(SECRET_ERROR)
    expect(screen.getByRole<HTMLButtonElement>('button', { name: en.phoneConnectionCopy }).disabled).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: en.phoneConnectionCopy }))
    await waitFor(() => { expect(screen.getByRole('alert').textContent).toBe(en.phoneConnectionCopied) })
  })

  it('shows a safe read failure with retry instead of presenting it as disabled setup', async () => {
    const description = vi.fn<NativePhoneConnection['describe']>()
      .mockRejectedValueOnce(new Error(SECRET_ERROR))
      .mockResolvedValueOnce({ enabled: true, remoteRoot: ROOT })
    mount({ ...native(true), describe: description })
    await screen.findByText(en.phoneConnectionReadFailed)
    expect(document.body.textContent).not.toContain(SECRET_ERROR)
    expect(screen.queryByText(en.phoneConnectionSetup)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: en.retry }))
    await screen.findByText(ROOT)
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it.each(['read', 'copy'] as const)('suppresses late %s publication and further calls after plugin disposal', async (operation) => {
    const read = Promise.withResolvers<Awaited<ReturnType<NativePhoneConnection['describe']>>>()
    const copy = Promise.withResolvers<undefined>()
    onTestFinished(() => {
      read.resolve({ enabled: false })
      copy.resolve(undefined)
    })
    const description = vi.fn<NativePhoneConnection['describe']>(() => operation === 'read'
      ? read.promise : Promise.resolve({ enabled: true, remoteRoot: ROOT }))
    const copyPairingUrl = vi.fn(() => copy.promise)
    const { controller } = mount({ describe: description, copyPairingUrl })
    if (operation === 'copy') {
      await screen.findByText(ROOT)
      fireEvent.click(screen.getByRole('button', { name: en.phoneConnectionCopy }))
    }
    const before = controller.state.getSnapshot()
    controller.dispose()
    await act(async () => {
      read.resolve({ enabled: true, remoteRoot: ROOT })
      if (operation === 'copy') {
        copy.reject(new Error(SECRET_ERROR))
        await expect(copy.promise).rejects.toThrow(SECRET_ERROR)
      } else copy.resolve(undefined)
      await read.promise
    })
    expect(controller.state.getSnapshot()).toBe(before)
    expect(controller.notice.getSnapshot()).toBeUndefined()
    await controller.describe()
    await controller.copy()
    expect(description).toHaveBeenCalledOnce()
    expect(copyPairingUrl).toHaveBeenCalledTimes(operation === 'copy' ? 1 : 0)
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it.each([['English', en], ['Chinese', zh]] as const)('renders the %s setup and access warnings from its dictionary', async (_language, dictionary) => {
    mount(native(false), dictionary)
    await screen.findByText(dictionary.phoneConnectionDisabled)
    screen.getByRole('region', { name: dictionary.phoneConnectionTitle })
    screen.getByText(dictionary.phoneConnectionSetup)
    screen.getByText(dictionary.phoneConnectionPrivateServe)
    screen.getByText(dictionary.phoneConnectionAccessWarning)
    screen.getByText(dictionary.phoneConnectionClipboardWarning)
  })

  it('prevents an older toast completion from dismissing a newer copy outcome', async () => {
    const { controller } = mount(native(true))
    await screen.findByText(ROOT)
    await act(async () => { await controller.copy() })
    const first = controller.notice.getSnapshot()
    if (first === undefined) throw new Error('expected copied notice')
    await act(async () => { await controller.copy() })
    act(() => { controller.dismiss(first.id) })
    expect(screen.getByRole('alert').textContent).toBe(en.phoneConnectionCopied)
    const current = controller.notice.getSnapshot()
    if (current === undefined) throw new Error('expected current copied notice')
    act(() => { controller.dismiss(current.id) })
    expect(screen.queryByRole('alert')).toBeNull()
  })
})
