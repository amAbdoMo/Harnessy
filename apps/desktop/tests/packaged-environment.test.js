import assert from 'node:assert/strict'
import { test } from 'node:test'
import { packagedDesktopEnvironment } from '../src/packaged-environment.js'

test('resolves installed resources separately from product-owned writable state', () => {
  const environment = packagedDesktopEnvironment('C:\\Program Files\\Harnessy\\resources', {
    LOCALAPPDATA: 'C:\\Users\\Test\\AppData\\Local',
    PATH: 'C:\\Windows\\System32',
  })
  assert.equal(environment.CUSTOM_HARNESS_PRODUCT_NAME, 'Harnessy')
  assert.equal(environment.CUSTOM_HARNESS_DESKTOP_APP_ID, 'com.amabdmo.customharness')
  assert.equal(environment.DSH_HOME, 'C:\\Users\\Test\\AppData\\Local\\CustomHarness\\Harness')
  assert.equal(environment.DSH_AGENTS_HOME, 'C:\\Users\\Test\\AppData\\Local\\CustomHarness\\Agents')
  assert.equal(environment.CUSTOM_HARNESS_DESKTOP_LOG_DIR, 'C:\\Users\\Test\\AppData\\Local\\CustomHarness\\Logs')
  assert.equal(environment.CUSTOM_HARNESS_DESKTOP_NODE_EXECUTABLE, 'C:\\Program Files\\Harnessy\\resources\\runtime\\node.exe')
  assert.equal(environment.CUSTOM_HARNESS_DESKTOP_DSH_ENTRY, 'C:\\Program Files\\Harnessy\\resources\\dsh\\lib\\bin.js')
  assert.equal(environment.CUSTOM_HARNESS_DESKTOP_WORKING_DIRECTORY, 'C:\\Program Files\\Harnessy\\resources\\dsh')
  assert.equal(environment.PATH, 'C:\\Windows\\System32')
})

test('accepts absolute managed roots and rejects relative writable roots', () => {
  const managed = packagedDesktopEnvironment('C:\\App\\resources', {
    LOCALAPPDATA: 'C:\\Local',
    CUSTOM_HARNESS_DATA_DIR: 'D:\\Managed\\Harness',
  })
  assert.equal(managed.DSH_HOME, 'D:\\Managed\\Harness\\Harness')
  assert.equal(managed.DSH_AGENTS_HOME, 'D:\\Managed\\Harness\\Agents')
  assert.throws(
    () => packagedDesktopEnvironment('C:\\App\\resources', {
      LOCALAPPDATA: 'C:\\Local',
      CUSTOM_HARNESS_DATA_DIR: '.\\relative',
    }),
    /must be an absolute path/u,
  )
})
