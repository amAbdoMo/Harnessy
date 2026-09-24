import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { packagedDesktopEnvironment } from '../src/packaged-environment.js'

test('upgrade and uninstall preserve product-owned state outside the installation directory', async t => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), 'custom-harness-data-lifecycle-'))
  t.after(() => rm(fixtureRoot, { recursive: true, force: true }))

  const localAppData = join(fixtureRoot, 'LocalAppData')
  const firstInstall = join(fixtureRoot, 'Install-v1', 'resources')
  const secondInstall = join(fixtureRoot, 'Install-v2', 'resources')
  const firstEnvironment = packagedDesktopEnvironment(firstInstall, { LOCALAPPDATA: localAppData })
  const secondEnvironment = packagedDesktopEnvironment(secondInstall, { LOCALAPPDATA: localAppData })
  const persistentFiles = [
    [join(firstEnvironment.DSH_HOME, 'settings.yaml'), 'theme: dark'],
    [join(firstEnvironment.DSH_HOME, 'sessions', 'session.jsonl'), '{"type":"session"}'],
    [join(firstEnvironment.DSH_HOME, 'credentials', 'provider.json'), '{"provider":"configured"}'],
    [join(firstEnvironment.DSH_AGENTS_HOME, 'skills', 'README.md'), 'skill state'],
    [join(firstEnvironment.CUSTOM_HARNESS_DESKTOP_USER_DATA, 'Cookies'), 'browser state'],
    [join(firstEnvironment.CUSTOM_HARNESS_DESKTOP_LOG_DIR, 'desktop.log'), 'diagnostic state'],
  ]

  await mkdir(firstInstall, { recursive: true })
  await mkdir(secondInstall, { recursive: true })
  for (const [path, contents] of persistentFiles) {
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, contents)
  }

  assert.notEqual(firstEnvironment.CUSTOM_HARNESS_DESKTOP_DSH_ENTRY, secondEnvironment.CUSTOM_HARNESS_DESKTOP_DSH_ENTRY)
  assert.equal(firstEnvironment.DSH_HOME, secondEnvironment.DSH_HOME)
  assert.equal(firstEnvironment.DSH_AGENTS_HOME, secondEnvironment.DSH_AGENTS_HOME)
  assert.equal(firstEnvironment.CUSTOM_HARNESS_DESKTOP_USER_DATA, secondEnvironment.CUSTOM_HARNESS_DESKTOP_USER_DATA)
  await rm(join(fixtureRoot, 'Install-v1'), { recursive: true })
  for (const [path, contents] of persistentFiles) assert.equal(await readFile(path, 'utf8'), contents)
})
