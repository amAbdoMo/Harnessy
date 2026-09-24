import assert from 'node:assert/strict'
import { test } from 'node:test'
import { externalWebUrl, isAllowedNavigation } from '../src/navigation.js'

test('only ordinary web URLs may leave the desktop window', () => {
  assert.equal(externalWebUrl('https://example.com/path')?.href, 'https://example.com/path')
  assert.equal(externalWebUrl('file:///C:/secret'), undefined)
  assert.equal(externalWebUrl('javascript:alert(1)'), undefined)
})

test('desktop navigation is limited to startup files and the active service origin', () => {
  assert.equal(isAllowedNavigation('file:///C:/app/startup.html', undefined), true)
  assert.equal(isAllowedNavigation('http://127.0.0.1:48765/session', 'http://127.0.0.1:48765'), true)
  assert.equal(isAllowedNavigation('http://127.0.0.1:48766/', 'http://127.0.0.1:48765'), false)
  assert.equal(isAllowedNavigation('file:///C:/app/startup.html', 'http://127.0.0.1:48765'), false)
})
