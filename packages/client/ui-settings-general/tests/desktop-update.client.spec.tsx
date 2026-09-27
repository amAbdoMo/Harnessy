// @vitest-environment jsdom
import type { GlobalStandardProps } from '@deepseek-ai/dsh-client-ui-slots'
import { afterEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useSyncExternalStore } from 'react'
import { DesktopUpdateControl } from '../src/client/DesktopUpdateControl.tsx'
import { DesktopUpdateSource } from '../src/client/desktop-update-source.ts'
import type { DesktopUpdateBridge, DesktopUpdatePresentation, DesktopUpdateView } from '../src/types.ts'
import { en, zh } from '../src/client/locales.ts'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

// The seat's key domain is settings ∪ common; the stub answers from the
// package dictionary and falls back to the key like the real chain.
function translate(dictionary: typeof zh | typeof en) {
  const messages: Readonly<Record<string, string>> = dictionary
  return (key: string, params?: Record<string, unknown>) => Object.entries(params ?? {})
    .reduce((message, [name, value]) => message.replaceAll(`{${name}}`, String(value)), messages[key] ?? key)
}

// Every fixture carries the seats the workspace header slot declares; the
// update control reads none of them.
const useResource = (() => ({ status: 'none' as const, value: undefined, failure: undefined, reload: () => {} })) as GlobalStandardProps['useResource']
const usePanelInfo: GlobalStandardProps['usePanelInfo'] = selector => selector({ activePanelId: null })
const unusedHook = (() => { throw new Error('unused by the update control') }) as never
const kit = {
  useSessions: unusedHook, useSessionStatus: unusedHook, usePanelInfo,
  useSessionRetainInfo: () => undefined, useResource, useWorkspaces: unusedHook,
}

function fixture() {
  let listener: ((state: DesktopUpdatePresentation) => void) | undefined
  const status = Promise.withResolvers<DesktopUpdatePresentation>()
  const unsubscribe = vi.fn()
  const open = vi.fn(async () => {})
  const check = vi.fn(async () => {})
  const cancelRestart = vi.fn(async () => {})
  const bridge: DesktopUpdateBridge = {
    status: () => status.promise,
    check,
    open,
    cancelRestart,
    subscribe: (next) => { listener = next; return unsubscribe },
  }
  const source = new DesktopUpdateSource(bridge)
  const subscribe = (notify: () => void) => source.store.subscribe(notify)
  const snapshot = () => source.store.getSnapshot()
  function useDesktopUpdate<T>(select: (view: DesktopUpdateView) => T): T {
    return select(useSyncExternalStore(subscribe, snapshot))
  }
  function Control({ dictionary = zh }: { dictionary?: typeof zh | typeof en }) {
    return <DesktopUpdateControl {...kit} t={translate(dictionary)} useDesktopUpdate={useDesktopUpdate}
      open={() => { void source.open() }} cancelRestart={() => { void source.cancelRestart() }} />
  }
  const view = render(<Control />)
  const unmount = view.unmount
  view.unmount = () => { source.dispose(); unmount() }
  return {
    open, check, cancelRestart, status, unsubscribe, view, source, Control, useDesktopUpdate,
    emit: async (state: DesktopUpdatePresentation) => { await act(async () => { listener?.(state) }) },
  }
}

const available = { phase: 'available', version: '1.0.1' } as const

/** Pointer input earlier in a test suppresses tooltips; a key restores keyboard modality. */
function focusWithKeyboard(element: HTMLElement): void {
  fireEvent.keyDown(document, { key: 'Tab' })
  fireEvent.focus(element)
}

it('renders nothing outside the Desktop carrier or while idle, and answers no action', async () => {
  const source = new DesktopUpdateSource(undefined)
  const view = render(<DesktopUpdateControl {...kit} t={translate(zh)}
    useDesktopUpdate={select => select(source.store.getSnapshot())}
    open={() => { void source.open() }} cancelRestart={() => { void source.cancelRestart() }} />)
  await act(async () => { await Promise.all([source.open(), source.check(), source.cancelRestart()]) })
  expect(view.container.innerHTML).toBe('')
  source.dispose()
  const idle = fixture()
  try {
    await idle.emit({ phase: 'idle' })
    await act(async () => { idle.status.resolve({ phase: 'idle' }) })
    expect(idle.view.container.innerHTML).toBe('')
  } finally { idle.view.unmount() }
})

it('offers the available release with its version detail and asks the shell to open it', async () => {
  const f = fixture()
  try {
    await f.emit(available)
    const control = screen.getByRole('button', { name: '新版本' })
    expect(control.getAttribute('aria-disabled')).toBe('false')
    expect(control.querySelector('svg')).toBeTruthy()
    focusWithKeyboard(control)
    expect((await screen.findByRole('tooltip')).textContent).toBe('新版本 — V1.0.1')
    fireEvent.click(control)
    expect(f.open).toHaveBeenCalledOnce()
    expect(f.check).not.toHaveBeenCalled()
  } finally { f.view.unmount(); f.status.resolve(available) }
})

it('renders determinate download progress and opens the progress popover', async () => {
  const f = fixture()
  try {
    await f.emit({ phase: 'downloading', version: '1.0.1', percent: 58, transferredBytes: 4_404_019, totalBytes: 12_582_912 })
    const control = screen.getByRole('button', { name: '正在下载更新：58%' })
    const ring = control.querySelectorAll('circle')
    expect(ring).toHaveLength(2)
    expect(Number(ring[1]!.getAttribute('stroke-dashoffset')))
      .toBeLessThan(Number(ring[1]!.getAttribute('stroke-dasharray')))
    expect(control.getAttribute('aria-expanded')).toBe('false')

    fireEvent.click(control)
    expect(f.open).not.toHaveBeenCalled()
    const dialog = screen.getByRole('dialog', { name: '正在下载更新' })
    expect(control.getAttribute('aria-expanded')).toBe('true')
    expect(dialog.textContent).toContain('58%')
    expect(dialog.textContent).toContain('目标版本：V1.0.1')
    expect(dialog.textContent).toContain('已下载 4.2MB / 12MB')
    expect(screen.getByRole('progressbar', { name: '正在下载更新' }).getAttribute('aria-valuenow')).toBe('58')

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(control)

    fireEvent.click(control)
    expect(screen.getByRole('dialog', { name: '正在下载更新' })).toBeTruthy()
    fireEvent.keyDown(document, { key: 'Enter' })
    expect(screen.getByRole('dialog', { name: '正在下载更新' })).toBeTruthy()
    fireEvent.pointerDown(document.body)
    expect(screen.queryByRole('dialog')).toBeNull()

    // A shell that reports no percentage or byte counts still renders a ring,
    // and the popover simply omits the rows it has no values for.
    await f.emit({ phase: 'downloading' })
    const bare = screen.getByRole('button', { name: '正在下载更新：0%' })
    expect(Number(bare.querySelectorAll('circle')[1]!.getAttribute('stroke-dashoffset')))
      .toBe(Number(bare.querySelectorAll('circle')[1]!.getAttribute('stroke-dasharray')))
    fireEvent.click(bare)
    const bareDialog = screen.getByRole('dialog', { name: '正在下载更新' })
    expect(bareDialog.textContent).toBe('正在下载更新0%')
  } finally { f.view.unmount(); f.status.resolve(available) }
})

it('clamps a shell percentage that leaves the 0-100 range', async () => {
  const f = fixture()
  try {
    await f.emit({ phase: 'downloading', percent: 140 })
    fireEvent.click(screen.getByRole('button', { name: '正在下载更新：100%' }))
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('100')
  } finally { f.view.unmount(); f.status.resolve(available) }
})

it('reports the indeterminate phases and refuses every click', async () => {
  const f = fixture()
  try {
    for (const [phase, label] of [
      ['checking', '正在检查更新…'],
      ['verifying', '正在校验更新文件…'],
      ['installing', '正在准备重启…'],
    ] as const) {
      await f.emit({ phase, version: '1.0.1' })
      const control = screen.getByRole('button', { name: label })
      expect(control.getAttribute('aria-disabled')).toBe('true')
      expect(control.querySelector('svg')).toBeTruthy()
      fireEvent.click(control)
      expect(f.open).not.toHaveBeenCalled()
    }
  } finally { f.view.unmount(); f.status.resolve(available) }
})

it('installs a ready release and retries a classified failure', async () => {
  const f = fixture()
  try {
    await f.emit({ phase: 'ready', version: '1.0.1' })
    const ready = screen.getByRole('button', { name: '安装并重启' })
    expect(ready.querySelector('span[aria-hidden="true"]')).toBeTruthy()
    fireEvent.click(ready)
    expect(f.open).toHaveBeenCalledOnce()

    await f.emit({ phase: 'error', version: '1.0.1', failure: 'disk' })
    const failed = screen.getByRole('button', { name: '重试更新' })
    expect(failed.getAttribute('aria-disabled')).toBe('false')
    focusWithKeyboard(failed)
    expect((await screen.findByRole('tooltip')).textContent).toBe('磁盘空间不足，请清理后重试。')
    fireEvent.click(failed)
    expect(f.open).toHaveBeenCalledTimes(2)

    await f.emit({ phase: 'error', failure: 'verify' })
    focusWithKeyboard(screen.getByRole('button', { name: '重试更新' }))
    expect((await screen.findByRole('tooltip')).textContent).toBe('更新文件校验失败，请重试。')
    await f.emit({ phase: 'error', failure: 'revoked' })
    focusWithKeyboard(screen.getByRole('button', { name: '重试更新' }))
    expect((await screen.findByRole('tooltip')).textContent).toBe('该版本已撤回，请检查更新。')
    // An unclassified failure keeps the install guidance.
    await f.emit({ phase: 'error' })
    focusWithKeyboard(screen.getByRole('button', { name: '重试更新' }))
    expect((await screen.findByRole('tooltip')).textContent).toBe('安装更新失败，请稍后重试。')
  } finally { f.view.unmount(); f.status.resolve(available) }
})

it('shows the staged restart and cancels it from the anchored popover', async () => {
  const f = fixture()
  const cancelling = Promise.withResolvers<undefined>()
  try {
    await f.emit({ phase: 'waiting', version: '1.0.1' })
    const control = screen.getByRole('button', { name: '等待安装' })
    focusWithKeyboard(control)
    expect((await screen.findByRole('tooltip')).textContent).toBe('任务结束后将自动安装并重启 — V1.0.1')

    fireEvent.click(control)
    const dialog = screen.getByRole('dialog', { name: '等待安装' })
    expect(dialog.textContent).toContain('任务结束后将自动安装并重启')
    expect(dialog.textContent).toContain('目标版本：V1.0.1')
    expect(screen.queryByRole('progressbar')).toBeNull()

    f.cancelRestart.mockImplementationOnce(() => cancelling.promise)
    const cancel = screen.getByRole('button', { name: '取消重启' })
    fireEvent.click(cancel)
    expect(f.cancelRestart).toHaveBeenCalledOnce()
    // The request is still in flight: the action disables and the control refuses a second one.
    expect(cancel.hasAttribute('disabled')).toBe(true)
    expect(control.getAttribute('aria-disabled')).toBe('true')
    await act(async () => { cancelling.resolve(undefined); await cancelling.promise })
    expect(screen.getByRole('button', { name: '取消重启' }).hasAttribute('disabled')).toBe(false)
    // The shell leaves the waiting phase once the restart is cancelled, which
    // takes the popover with it.
    await f.emit({ phase: 'available', version: '1.0.1' })
    expect(screen.queryByRole('dialog')).toBeNull()
  } finally { f.view.unmount(); f.status.resolve(available) }
})

it('keeps a failed carrier retryable and drops the popover with its phase', async () => {
  const f = fixture()
  try {
    await act(async () => { f.status.reject(new Error('IPC unavailable')) })
    const retry = screen.getByRole('button', { name: '重试更新' })
    focusWithKeyboard(retry)
    expect((await screen.findByRole('tooltip')).textContent).toBe('重试更新')
    fireEvent.click(retry)
    expect(f.open).toHaveBeenCalledOnce()

    expect(f.source.store.getSnapshot().failed).toBe(true)
    await f.emit({ phase: 'downloading', percent: 10 })
    expect(f.source.store.getSnapshot().failed).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: '正在下载更新：10%' }))
    expect(screen.getByRole('dialog')).toBeTruthy()
    // The phase that owns the popover is gone, so the panel goes with it.
    await f.emit({ phase: 'ready', version: '1.0.1' })
    expect(screen.queryByRole('dialog')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '安装并重启' }))
    expect(f.open).toHaveBeenCalledTimes(2)
  } finally { f.view.unmount(); f.status.resolve(available) }
})

it('coalesces shell actions, ignores late events, and guards each action by phase', async () => {
  const f = fixture()
  const pending = Promise.withResolvers<undefined>()
  try {
    await act(async () => { f.status.resolve(available) })
    expect(screen.getByRole('button', { name: '新版本' })).toBeTruthy()

    await f.emit({ phase: 'verifying', version: available.version })
    void f.source.open()
    await f.source.check()
    expect(f.open).not.toHaveBeenCalled()
    expect(f.check).not.toHaveBeenCalled()

    await f.emit({ phase: 'checking', version: available.version })
    await f.source.check()
    expect(f.check).not.toHaveBeenCalled()

    await f.emit({ phase: 'ready', version: available.version })
    await f.source.cancelRestart()
    expect(f.cancelRestart).not.toHaveBeenCalled()

    await f.emit({ phase: 'waiting', version: available.version })
    await act(async () => { await f.source.cancelRestart() })
    expect(f.cancelRestart).toHaveBeenCalledOnce()

    await f.emit(available)
    f.open.mockImplementationOnce(() => pending.promise)
    act(() => { void f.source.open(); void f.source.open() })
    expect(f.open).toHaveBeenCalledOnce()
    expect(f.source.store.getSnapshot().busy).toBe(true)
    const state = f.source.store.getSnapshot()
    f.view.unmount()
    void f.source.check()
    await f.emit({ phase: 'error', version: available.version, failure: 'install' })
    await act(async () => { pending.reject(new Error('late IPC failure')) })
    expect(f.source.store.getSnapshot()).toBe(state)
  } finally { pending.resolve(undefined); f.status.resolve(available) }
})

it('marks a rejected action as failed and stays quiet for a status failure beaten by an event', async () => {
  const f = fixture()
  const late = fixture()
  try {
    await act(async () => { f.status.resolve(available) })
    f.open.mockRejectedValueOnce(new Error('IPC unavailable'))
    fireEvent.click(screen.getByRole('button', { name: '新版本' }))
    await act(async () => { await Promise.resolve() })
    expect(f.source.store.getSnapshot().failed).toBe(true)

    await late.emit(available)
    await act(async () => { late.status.reject(new Error('stale initial request')) })
    expect(late.source.store.getSnapshot().failed).toBe(false)
  } finally { f.view.unmount(); late.view.unmount(); f.status.resolve(available) }
})

it('renders the same semantic update in the active Web locale', async () => {
  const f = fixture()
  try {
    await f.emit(available)
    expect(screen.getByRole('button', { name: '新版本' })).toBeTruthy()
    f.view.rerender(<f.Control dictionary={en} />)
    expect(screen.getByRole('button', { name: 'Update' })).toBeTruthy()
  } finally { f.view.unmount(); f.status.resolve(available) }
})
