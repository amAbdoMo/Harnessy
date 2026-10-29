/** Native tab ownership survives turns while handoffs fence queued agent actions. */
import { expect, it, vi } from 'vitest'
import { BrowserTabControl } from '../src/browser-tab-control.ts'

it('allows its owning chat and refuses another chat', async () => {
  const control = new BrowserTabControl('chat-one')
  await expect(control.act('chat-one', async () => 'done')).resolves.toBe('done')
  expect(() => control.act('chat-two', async () => 'wrong')).toThrow('another chat')
})

it('allows any chat to act on an unclaimed tab', async () => {
  const control = new BrowserTabControl(null)
  await expect(control.act('chat-one', async () => 1)).resolves.toBe(1)
  await expect(control.act('chat-two', async () => 2)).resolves.toBe(2)
})

it('keeps observations available during human takeover and resumes actions explicitly', async () => {
  const control = new BrowserTabControl('chat')
  await control.control(true)
  expect(() => control.act('chat', async () => null)).toThrow('human controls')
  await expect(control.observe(async () => 'page')).resolves.toBe('page')
  await control.control(false)
  await expect(control.act('chat', async () => 'resumed')).resolves.toBe('resumed')
})

it('drains active work and refuses queued work from the previous control generation', async () => {
  const control = new BrowserTabControl('chat')
  const active = Promise.withResolvers<undefined>()
  const started = Promise.withResolvers<undefined>()
  const first = control.act('chat', async () => { started.resolve(undefined); await active.promise })
  await started.promise
  const queuedAction = vi.fn(async () => 'should not run')
  const queued = control.act('chat', queuedAction)
  const refused = expect(queued).rejects.toThrow('human controls')
  let drained = false
  const takeover = control.control(true).then(() => { drained = true })
  expect(control.humanControl).toBe(true)
  expect(control.humanMayAct).toBe(false)
  expect(drained).toBe(false)
  active.resolve(undefined)
  await Promise.all([first, refused, takeover])
  expect(queuedAction).not.toHaveBeenCalled()
  expect(control.humanMayAct).toBe(true)
  await control.control(false)
  expect(control.generation).toBe(2)
})

it('fences old queued work even after a rapid human take and release', async () => {
  const control = new BrowserTabControl('chat')
  const active = Promise.withResolvers<undefined>()
  const started = Promise.withResolvers<undefined>()
  const first = control.act('chat', async () => { started.resolve(undefined); await active.promise })
  await started.promise
  const second = control.act('chat', async () => 'stale')
  const refused = expect(second).rejects.toThrow('control changed')
  const take = control.control(true)
  const release = control.control(false)
  active.resolve(undefined)
  await Promise.all([first, refused, take, release])
})

it('closes admission before waiting for active work to settle', async () => {
  const control = new BrowserTabControl('chat')
  const active = Promise.withResolvers<undefined>()
  const started = Promise.withResolvers<undefined>()
  const action = control.act('chat', async () => { started.resolve(undefined); await active.promise })
  await started.promise
  const closing = control.close()
  expect(() => control.observe(async () => null)).toThrow('closed')
  expect(() => control.act('chat', async () => null)).toThrow('closed')
  active.resolve(undefined)
  await Promise.all([action, closing])
})
