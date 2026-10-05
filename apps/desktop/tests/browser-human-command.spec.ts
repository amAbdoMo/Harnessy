/** Human IPC navigation uses the real account authority and a controlled Electron navigation adapter. */
import { expect, it, vi } from 'vitest'
import type { DesktopBrowserHumanCommand } from '@deepseek-ai/dsh-client-ui-sidebar-browser/types'
import { executeHumanBrowserCommand } from '../src/browser-human-command.ts'
import { websiteAuthorityFixture } from './website-authority-fixture.ts'

const commands: readonly DesktopBrowserHumanCommand[] = [
  { kind: 'navigate', url: 'https://portal.example.test/next' }, { kind: 'back' }, { kind: 'forward' }, { kind: 'reload' },
]

function fixture() {
  const f = websiteAuthorityFixture()
  const events: string[] = []
  const native = Object.assign(f.guest, {
    loadURL: async (_url: string) => { events.push('navigate') },
    reload: () => { events.push('reload') },
    navigationHistory: {
      canGoBack: (): boolean => true, canGoForward: (): boolean => true,
      goBack: () => { events.push('back') }, goForward: () => { events.push('forward') },
    },
  })
  return { ...f, native, events,
    run: (input: unknown) => executeHumanBrowserCommand(native, input, url => url.startsWith(f.profile.url),
      () => f.authority.allowsNativeNavigation(f.owner, f.lease)),
    async resume() {
      f.prepare()
      await f.authority.requests.resume(f.owner, f.authority.prepare(f.owner, f.snapshot().id, f.lease))
    },
  }
}

it.each(commands)('dispatches $kind only while the account remains in Human mode', async (command) => {
  const f = fixture()
  await f.run(command)
  expect(f.events).toEqual([command.kind])
})

it.each(commands)('rejects deferred $kind after Resume without native dispatch or page observation', async (command) => {
  const f = fixture()
  const deferred = () => f.run(command)
  await f.resume()
  vi.mocked(f.nativeGuest.getURL).mockClear()
  vi.mocked(f.nativeGuest.getTitle).mockClear()
  await expect(deferred()).rejects.toThrow('Human Takeover')
  expect(f.events).toEqual([])
  expect(f.nativeGuest.getURL).not.toHaveBeenCalled()
  expect(f.nativeGuest.getTitle).not.toHaveBeenCalled()
})

it('keeps Human commands denied throughout physical Host drainage and permits them afterward', async () => {
  const f = fixture()
  await f.resume()
  const entered: PromiseWithResolvers<void> = Promise.withResolvers()
  const drained: PromiseWithResolvers<void> = Promise.withResolvers()
  const dispatch = f.control.getMockImplementation()
  if (dispatch === undefined) throw new Error('Private Host dispatcher missing')
  f.control.mockImplementation(async (command) => {
    if (command.action === 'drain') { entered.resolve(); await drained.promise; return undefined }
    return dispatch(command)
  })
  const takeover = f.authority.takeover(f.profile.id)
  try {
    await Promise.race([entered.promise, takeover.then(() => { throw new Error('Takeover settled without drainage admission') })])
    for (const command of commands) await expect(f.run(command)).rejects.toThrow('Human Takeover')
    expect(f.events).toEqual([])
  } finally { drained.resolve(); await takeover }
  await f.run({ kind: 'reload' })
  expect(f.events).toEqual(['reload'])
})

it.each([
  null, [], 'reload', {}, { kind: 'evaluate', code: 'document.body.textContent' }, { kind: 'navigate' },
  { kind: 'navigate', url: 1 }, { kind: 'navigate', url: 'https://other.example.test/' },
  { kind: 'navigate', url: 'https://portal.example.test/next', code: 'unexpected' }, { kind: 'reload', url: 'unexpected' },
  { kind: 'navigate', url: 'https://portal.example.test/' + '🧭'.repeat(1200) },
])('rejects malformed, unauthorized or oversized renderer packet %# before native dispatch', async (input) => {
  const f = fixture()
  await expect(f.run(input)).rejects.toThrow('command rejected')
  expect(f.events).toEqual([])
})

it('does not dispatch a history command when no destination exists', async () => {
  const f = fixture()
  f.native.navigationHistory.canGoBack = () => false
  f.native.navigationHistory.canGoForward = () => false
  await f.run({ kind: 'back' })
  await f.run({ kind: 'forward' })
  expect(f.events).toEqual([])
})

it('excludes private native diagnostics from IPC failures and treats a superseded load as settled', async () => {
  const f = fixture()
  f.native.loadURL = async () => { throw new Error('private authentication URL and diagnostics') }
  await expect(f.run(commands[0])).rejects.toThrow(/^Desktop browser native command failed$/)
  f.native.loadURL = async () => { throw Object.assign(new Error('private superseded URL'), { code: 'ERR_ABORTED' }) }
  await expect(f.run(commands[0])).resolves.toBeUndefined()
})

it('accepts an exactly 4096-byte URL and rejects the next byte', async () => {
  const f = fixture()
  const url = f.profile.url + 'a'.repeat(4096 - f.profile.url.length)
  await f.run({ kind: 'navigate', url })
  await expect(f.run({ kind: 'navigate', url: url + 'a' })).rejects.toThrow('command rejected')
  expect(f.events).toEqual(['navigate'])
})
