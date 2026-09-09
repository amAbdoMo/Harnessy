import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createWindowOptions } from '../src/window-options.js'

test('renderer isolation is strict and native resizing remains enabled', () => {
  const options = createWindowOptions({ icon: 'icon.png', productName: 'Custom Harness' })
  assert.equal(options.resizable, undefined)
  assert.equal(options.webPreferences.contextIsolation, true)
  assert.equal(options.webPreferences.nodeIntegration, false)
  assert.equal(options.webPreferences.sandbox, true)
  assert.equal(options.webPreferences.webviewTag, false)
  assert.equal(options.title, 'Custom Harness')
})
