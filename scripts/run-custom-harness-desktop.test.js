import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { assertCustomHarnessBuildRecord, desktopEnvironment } from './run-custom-harness-desktop.ts'

test('desktop source launcher passes the named profile and isolated paths', () => {
  const paths = {
    data: 'C:\\Users\\Test\\AppData\\Local\\CustomHarness',
    home: 'C:\\Users\\Test\\AppData\\Local\\CustomHarness\\Harness',
    agents: 'C:\\Users\\Test\\AppData\\Local\\CustomHarness\\Agents',
    logs: 'C:\\Users\\Test\\AppData\\Local\\CustomHarness\\Logs',
    cache: 'C:\\Users\\Test\\AppData\\Local\\CustomHarness\\Cache',
  }
  const environment = desktopEnvironment(paths, 'C:\\electron.exe', 'C:\\node.exe', {})
  assert.equal(environment.DSH_HOME, 'C:\\Users\\Test\\AppData\\Local\\CustomHarness\\Harness')
  assert.equal(environment.DSH_AGENTS_HOME, 'C:\\Users\\Test\\AppData\\Local\\CustomHarness\\Agents')
  assert.equal(environment.CUSTOM_HARNESS_DESKTOP_PROFILE, 'custom-harness')
  assert.equal(environment.CUSTOM_HARNESS_PRODUCT_NAME, 'Harnessy')
  assert.equal(environment.CUSTOM_HARNESS_DESKTOP_APP_ID, 'com.amabdmo.customharness')
  assert.equal(environment.CUSTOM_HARNESS_DESKTOP_LOG_DIR, paths.logs)
  assert.equal(
    environment.CUSTOM_HARNESS_DESKTOP_WORKING_DIRECTORY,
    resolve(fileURLToPath(new URL('..', import.meta.url))),
  )
  assert.match(environment.CUSTOM_HARNESS_DESKTOP_DSH_ENTRY, /apps[\\/]cli[\\/]lib[\\/]bin\.js$/u)
})

test('build preflight accepts repository metadata but rejects another product profile', () => {
  const buildRecord = {
    formatVersion: 1,
    environment: {
      DSH_CLIENT_BUILD_PROFILE: 'custom-harness',
      DSH_CLIENT_COMMIT_HASH: 'a66e470',
      DSH_CLIENT_ICON_PATH: '/harnessy.png',
      DSH_CLIENT_MANIFEST_SHORT_NAME: 'Harnessy',
      DSH_CLIENT_MARK_PATH: '/harnessy-mark.png',
      DSH_CLIENT_PRODUCT_NAME: 'Harnessy',
      DSH_CLIENT_PRODUCT_SLUG: 'custom-harness',
      DSH_CLIENT_PRODUCT_URL: 'https://github.com/amAbdoMo/Harnessy',
      DSH_CLIENT_SUPPORT_URL: 'https://github.com/amAbdoMo/Harnessy/issues',
      DSH_CLIENT_TITLE: 'Harnessy',
      DSH_CLIENT_VERSION: '0.1.2-rc.1',
    },
    artifacts: { fileCount: 1, sha256: '0'.repeat(64) },
  }
  assert.doesNotThrow(() => assertCustomHarnessBuildRecord(buildRecord))
  assert.throws(
    () => assertCustomHarnessBuildRecord({
      ...buildRecord,
      environment: { ...buildRecord.environment, DSH_CLIENT_BUILD_PROFILE: 'official' },
    }),
    /does not describe Harnessy/u,
  )
})
