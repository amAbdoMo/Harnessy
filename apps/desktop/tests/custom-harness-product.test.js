import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  CUSTOM_HARNESS_PRODUCT,
  resolveDevelopmentCustomHarnessDesktopState,
  resolvePackagedCustomHarnessDesktopState,
} from '../../../scripts/custom-harness-product.mjs'

test('resolves stable packaged state and ignores ambient Harness homes', () => {
  const first = resolvePackagedCustomHarnessDesktopState('C:\\Users\\Test\\AppData\\Local')
  const second = resolvePackagedCustomHarnessDesktopState('C:\\Users\\Test\\AppData\\Local')
  assert.deepEqual(first, second)
  assert.equal(first.home, 'C:\\Users\\Test\\AppData\\Local\\CustomHarness\\Harness')
  assert.equal(first.agents, 'C:\\Users\\Test\\AppData\\Local\\CustomHarness\\Agents')
  assert.equal(first.userData, 'C:\\Users\\Test\\AppData\\Local\\CustomHarness\\Cache\\DesktopUserData')
  assert.deepEqual(CUSTOM_HARNESS_PRODUCT.desktopProfileBundles, [
    '@deepseek-ai/dsh-base',
    '@deepseek-ai/dsh-web-app',
    '@deepseek-ai/dsh-custom-harness',
  ])
  assert.equal(CUSTOM_HARNESS_PRODUCT.automaticUpdates, false)
})

test('allows only absolute development overrides', () => {
  const state = resolveDevelopmentCustomHarnessDesktopState('C:\\Development', {
    CUSTOM_HARNESS_DATA_DIR: 'D:\\Managed\\CustomHarness',
    DSH_HOME: 'D:\\Managed\\CustomHarness\\Harness',
  })
  assert.equal(state.data, 'D:\\Managed\\CustomHarness')
  assert.equal(state.home, 'D:\\Managed\\CustomHarness\\Harness')
  assert.throws(
    () => resolveDevelopmentCustomHarnessDesktopState('C:\\Development', {
      CUSTOM_HARNESS_DATA_DIR: '.\\relative',
    }),
    /must be an absolute path/u,
  )
})
