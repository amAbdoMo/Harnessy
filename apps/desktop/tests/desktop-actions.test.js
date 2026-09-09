import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { test } from 'node:test'
import { acquireSingleInstance, openServiceInSystemBrowser } from '../src/desktop-actions.js'

test('a second launch focuses the existing window without invoking backend work', () => {
  class FakeApp extends EventEmitter {
    requestSingleInstanceLock() { return true }
  }
  const calls = []
  const window = {
    isMinimized: () => true,
    restore: () => calls.push('restore'),
    show: () => calls.push('show'),
    focus: () => calls.push('focus'),
  }
  const app = new FakeApp()
  assert.equal(acquireSingleInstance(app, () => window), true)
  app.emit('second-instance')
  assert.deepEqual(calls, ['restore', 'show', 'focus'])
})

test('a secondary process is rejected before it registers lifecycle work', () => {
  const app = { requestSingleInstanceLock: () => false, on: () => assert.fail('must not register') }
  assert.equal(acquireSingleInstance(app, () => undefined), false)
})

test('browser handoff preserves the authenticated local URL and reports failures', async () => {
  let opened
  const launchUrl = 'http://127.0.0.1:48765/?token=secret'
  assert.equal(await openServiceInSystemBrowser(launchUrl, async url => { opened = url }), launchUrl)
  assert.equal(opened, launchUrl)
  await assert.rejects(openServiceInSystemBrowser(launchUrl, async () => { throw new Error('browser failed') }), /browser failed/u)
  await assert.rejects(openServiceInSystemBrowser('file:///C:/secret', async () => {}), /not ready/u)
})
