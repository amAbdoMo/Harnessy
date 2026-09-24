import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createDesktopLog } from '../src/desktop-log.js'

test('rotates bounded diagnostics and keeps only the configured archive count', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'custom-harness-log-'))
  t.after(async () => {
    const { rm } = await import('node:fs/promises')
    await rm(directory, { recursive: true, force: true })
  })
  const log = createDesktopLog(directory, { maxBytes: 8, archives: 2 })
  log.write('12345678')
  log.write('abcdefgh')
  log.write('ABCDEFGH')
  log.write('final')
  await log.flush()
  assert.deepEqual((await readdir(directory)).sort(), ['desktop.log', 'desktop.log.1', 'desktop.log.2'])
  assert.equal(await readFile(join(directory, 'desktop.log'), 'utf8'), 'final')
  assert.equal(await readFile(join(directory, 'desktop.log.1'), 'utf8'), 'ABCDEFGH')
  assert.equal(await readFile(join(directory, 'desktop.log.2'), 'utf8'), 'abcdefgh')
})

test('sanitizes diagnostics before writing them', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'custom-harness-log-'))
  t.after(async () => {
    const { rm } = await import('node:fs/promises')
    await rm(directory, { recursive: true, force: true })
  })
  const log = createDesktopLog(directory, {
    sanitize: value => value.replaceAll('secret', '[redacted]'),
  })
  log.write('token=secret')
  await log.flush()
  assert.equal(await readFile(log.path, 'utf8'), 'token=[redacted]')
})

test('keeps a single oversized write within the configured byte limit', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'custom-harness-log-'))
  t.after(async () => {
    const { rm } = await import('node:fs/promises')
    await rm(directory, { recursive: true, force: true })
  })
  const log = createDesktopLog(directory, { maxBytes: 8, archives: 2 })
  log.write('discarded-final')
  await log.flush()
  assert.equal(await readFile(log.path, 'utf8'), 'ed-final')
})
