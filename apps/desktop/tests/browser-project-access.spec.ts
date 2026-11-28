/** Main-owned project preferences persist and serialize independent writes. */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { expect, it, onTestFinished, vi } from 'vitest'
import { BrowserProjectAccess, browserProjectId } from '../src/browser-project-access.ts'

async function preferencePath() {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-browser-project-access-'))
  onTestFinished(() => rm(directory, { recursive: true, force: true }))
  return join(directory, 'browser-project-access.json')
}

it('defaults to allowed, commits independent project choices, and reads them after a restart', async () => {
  const path = await preferencePath()
  const access = new BrowserProjectAccess(path)
  const first = browserProjectId(randomUUID()), second = browserProjectId(randomUUID())
  const revoked = vi.fn()
  await expect(access.allows(first)).resolves.toBe(true)
  await Promise.all([access.set(first, false, revoked), access.set(second, false, revoked)])
  expect(revoked).toHaveBeenCalledTimes(2)
  await access.set(second, true, revoked)
  const reopened = new BrowserProjectAccess(path)
  await expect(reopened.list()).resolves.toEqual([first])
  await expect(reopened.allows(first)).resolves.toBe(false)
  await expect(reopened.allows(second)).resolves.toBe(true)
})

it('fails closed when the persisted project list is malformed', async () => {
  const path = await preferencePath()
  await writeFile(path, '["invalid"]')
  const access = new BrowserProjectAccess(path)
  await expect(access.allows(browserProjectId(randomUUID()))).rejects.toThrow('Invalid browser project identity')
})
