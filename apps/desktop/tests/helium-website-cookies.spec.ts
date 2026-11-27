/** Helium transfer limits by site, persistence, and browser protection. */
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { expect, it, onTestFinished } from 'vitest'
import { readHeliumWebsiteCookies } from '../src/helium-website-cookies.ts'

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'harnessy-helium-cookies-'))
  onTestFinished(async () => rm(root, { recursive: true, force: true }))
  const network = join(root, 'Network')
  await mkdir(network)
  const db = new DatabaseSync(join(network, 'Cookies'))
  db.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT); INSERT INTO meta VALUES ('version', '24')")
  db.exec('CREATE TABLE cookies (name TEXT, value TEXT, encrypted_value BLOB, host_key TEXT, path TEXT, '
    + 'is_secure INTEGER, is_httponly INTEGER, samesite INTEGER, expires_utc INTEGER, is_persistent INTEGER, top_frame_site_key TEXT)')
  const expiry = 11644473600000000n + BigInt(Date.now() + 60_000) * 1000n
  return { root, db, expiry, insert: db.prepare('INSERT INTO cookies VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)') }
}

it('copies only persistent, unpartitioned cookies for the confirmed hostname', async () => {
  const { root, db, expiry, insert } = await fixture()
  try {
    insert.run('fixture_login', 'yes', Buffer.alloc(0), '.site.example.test', '/account', 1, 1, 2, expiry, 1, '')
    insert.run('parent', 'no', Buffer.alloc(0), '.example.test', '/', 1, 1, 1, expiry, 1, '')
    insert.run('foreign', '', Buffer.from('v20foreign'), 'foreign.example.test', '/', 1, 1, 1, expiry, 1, '')
    insert.run('partitioned', 'no', Buffer.alloc(0), 'site.example.test', '/', 1, 1, 1, expiry, 1, 'https://top.example')
    insert.run('session', 'no', Buffer.alloc(0), 'site.example.test', '/', 1, 1, 1, expiry, 0, '')
    insert.run('expired', 'no', Buffer.alloc(0), 'site.example.test', '/', 1, 1, 1, expiry - 120000000n, 1, '')
  } finally { db.close() }
  await expect(readHeliumWebsiteCookies(root, new URL('https://site.example.test/account'))).resolves.toEqual([{
    url: 'https://site.example.test', name: 'fixture_login', value: 'yes', path: '/account', domain: '.site.example.test',
    secure: true, httpOnly: true, sameSite: 'strict', expirationDate: Number(expiry - 11644473600000000n) / 1_000_000,
  }])
  await expect(readHeliumWebsiteCookies(root, new URL('http://site.example.test/'))).rejects.toThrow('session-import-site')
})

it('declines application-bound protection on the selected website', async () => {
  const { root, db, expiry, insert } = await fixture()
  try {
    insert.run('fixture_login', '', Buffer.from('v20protected'), 'site.example.test', '/', 1, 1, 1, expiry, 1, '')
  } finally { db.close() }
  await expect(readHeliumWebsiteCookies(root, new URL('https://site.example.test/'))).rejects.toThrow('session-import-protection')
})
