/** Firefox schema compatibility and origin-scoped import. */
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { expect, it, onTestFinished } from 'vitest'
import { readFirefoxWebsiteCookies } from '../src/firefox-website-cookies.ts'

it.each([15, 17])('copies only ordinary persistent cookies for the selected site in schema %i', async (version) => {
  const root = await mkdtemp(join(tmpdir(), 'harnessy-firefox-cookies-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  const path = join(root, 'cookies.sqlite')
  const db = new DatabaseSync(path)
  const expiry = Math.floor(Date.now() / 1000) + 86400
  const scale = version >= 16 ? 1000 : 1
  try {
    db.exec(`PRAGMA user_version=${version};
      CREATE TABLE moz_cookies (name TEXT, value TEXT, host TEXT, path TEXT, expiry INTEGER,
        isSecure INTEGER, isHttpOnly INTEGER, sameSite INTEGER, originAttributes TEXT, isPartitionedAttributeSet INTEGER)`)
    const put = db.prepare("INSERT INTO moz_cookies VALUES (?, 'fixture-only', ?, '/', ?, 1, 1, 1, ?, ?)")
    put.run('session', 'site.example.test', expiry * scale, '', 0)
    put.run('domain-cookie', '.site.example.test', expiry * scale, '', 0)
    put.run('subdomain', 'sub.site.example.test', expiry * scale, '', 0)
    put.run('parent', '.example.test', expiry * scale, '', 0)
    put.run('contained', 'site.example.test', expiry * scale, '^userContextId=1', 0)
    put.run('partitioned', 'site.example.test', expiry * scale, '', 1)
    put.run('expired', 'site.example.test', 0, '', 0)
  } finally {
    db.close()
  }
  const original = await readFile(path)
  const cookies = await readFirefoxWebsiteCookies(path, new URL('https://site.example.test/start'))
  const expected = { secure: true, httpOnly: true, sameSite: 'lax', path: '/', expirationDate: expiry, url: 'https://site.example.test' }
  expect(cookies).toHaveLength(2)
  expect(cookies).toEqual(expect.arrayContaining([
    expect.objectContaining({ ...expected, name: 'session' }),
    expect.objectContaining({ ...expected, name: 'domain-cookie', domain: '.site.example.test' }),
  ]))
  expect(cookies.find(cookie => cookie.name === 'session')?.domain).toBeUndefined()
  await expect(readFirefoxWebsiteCookies(path, new URL('https://other.example.test/'))).rejects.toThrow('session-import-empty')
  await expect(readFirefoxWebsiteCookies(path, new URL('http://site.example.test/'))).rejects.toThrow('session-import-site')
  await expect(readFirefoxWebsiteCookies(path, new URL('https://192.168.1.2/'))).rejects.toThrow('session-import-site')
  expect(await readFile(path)).toEqual(original)
})
