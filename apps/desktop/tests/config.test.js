import assert from 'node:assert/strict'
import { test } from 'node:test'
import { resolveDesktopConfig } from '../src/config.js'

const required = {
  CUSTOM_HARNESS_DESKTOP_APP_ID: 'com.example.harness',
  CUSTOM_HARNESS_PRODUCT_NAME: 'Harnessy',
  CUSTOM_HARNESS_DESKTOP_PROFILE: 'custom-harness',
  CUSTOM_HARNESS_DESKTOP_NODE_EXECUTABLE: 'C:\\runtime\\node.exe',
  CUSTOM_HARNESS_DESKTOP_DSH_ENTRY: 'C:\\app\\bin.js',
  CUSTOM_HARNESS_DESKTOP_JOB_LAUNCHER: 'C:\\app\\job.exe',
  CUSTOM_HARNESS_DESKTOP_WORKING_DIRECTORY: 'C:\\app',
  CUSTOM_HARNESS_DESKTOP_USER_DATA: 'C:\\data\\desktop',
  CUSTOM_HARNESS_DESKTOP_LOG_DIR: 'C:\\data\\logs',
  CUSTOM_HARNESS_DESKTOP_ICON: 'C:\\app\\icon.png',
}

test('resolves an explicit Windows desktop boundary and bounded defaults', () => {
  const config = resolveDesktopConfig(required)
  assert.equal(config.productName, 'Harnessy')
  assert.equal(config.profile, 'custom-harness')
  assert.equal(config.port, 48_765)
  assert.equal(config.healthFailureLimit, 3)
})

test('rejects missing paths and invalid numeric overrides', () => {
  assert.throws(() => resolveDesktopConfig({ ...required, CUSTOM_HARNESS_DESKTOP_ICON: '' }), /requires/u)
  assert.throws(() => resolveDesktopConfig({ ...required, CUSTOM_HARNESS_DESKTOP_PORT: '70000' }), /positive integer/u)
})
