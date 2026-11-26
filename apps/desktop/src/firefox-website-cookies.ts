/** Main-only import of ordinary persistent Firefox cookies for one approved website. */
import { stat } from 'node:fs/promises'
import { basename } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { CookiesSetDetails } from 'electron'
import { localBrowserDeviceOrigin } from './browser-certificates.ts'
import { WebsiteProfileError } from './website-profile-errors.ts'

const MAX_COOKIE_DATABASE_BYTES = 32 * 1024 * 1024
const MAX_SITE_COOKIES = 256

/** @param site - validated landing URL. @returns whether cookie transfer is available for this site. */
export function canImportFirefoxWebsiteCookies(site: URL): boolean {
  return (site.protocol === 'https:' && localBrowserDeviceOrigin(site.href) === undefined)
    || (site.protocol === 'http:' && site.hostname === 'localhost')
}

function sameSite(value: unknown): NonNullable<CookiesSetDetails['sameSite']> {
  switch (value) {
    case 0: return 'no_restriction'
    case 1: return 'lax'
    case 2: return 'strict'
    default: return 'unspecified'
  }
}

/**
 * Read the selected Firefox profile database without modifying it.
 * @param filename - native-picker selection, never a renderer-supplied path.
 * @param site - the approved destination. Parent domains and other sites are excluded.
 * @returns cookie settings kept in Main until they are installed in a new profile.
 */
export async function readFirefoxWebsiteCookies(filename: string, site: URL): Promise<readonly CookiesSetDetails[]> {
  if (!canImportFirefoxWebsiteCookies(site)) {
    throw new WebsiteProfileError('session-import-site', 'Firefox import requires a secure website')
  }
  let cookies: CookiesSetDetails[]
  try {
    const file = await stat(filename)
    if (basename(filename).toLowerCase() !== 'cookies.sqlite' || !file.isFile() || file.size > MAX_COOKIE_DATABASE_BYTES) {
      throw new Error('Unexpected Firefox database')
    }
    const db = new DatabaseSync(filename, { readOnly: true, allowExtension: false })
    try {
      db.exec('PRAGMA trusted_schema=OFF')
      if (db.prepare("SELECT type FROM pragma_table_list('moz_cookies') WHERE schema = 'main'").get()?.type !== 'table') {
        throw new Error('Expected a Firefox cookies table')
      }
      // Firefox cookie schema 16 stores expiry in milliseconds.
      const version = db.prepare('PRAGMA user_version').get()?.user_version
      const scale = typeof version === 'number' && version >= 16 ? 1000 : 1
      const now = Date.now() / 1000
      const hasPartitionFlag = db.prepare('PRAGMA table_info(moz_cookies)').all()
        .some(column => column.name === 'isPartitionedAttributeSet')
      const rows = db.prepare(`SELECT name, value, host, path, expiry, isSecure, isHttpOnly, sameSite
        FROM moz_cookies
        WHERE originAttributes = '' AND host IN (?, ?) AND expiry > ?
          ${hasPartitionFlag ? 'AND isPartitionedAttributeSet = 0' : ''}
          AND length(name) + length(value) <= 4096 AND length(path) <= 1024
        LIMIT ?`).all(site.hostname, '.' + site.hostname, now * scale, MAX_SITE_COOKIES + 1)
      if (rows.length > MAX_SITE_COOKIES) throw new Error('Too many Firefox cookies for one site')
      cookies = rows.flatMap((row) => {
        if (typeof row.name !== 'string' || typeof row.value !== 'string' || typeof row.path !== 'string'
          || !row.path.startsWith('/') || /[\x00-\x1f\x7f]/u.test(row.path)
          || typeof row.expiry !== 'number' || !Number.isSafeInteger(row.expiry)
          || (row.isSecure !== 0 && row.isSecure !== 1) || (row.isHttpOnly !== 0 && row.isHttpOnly !== 1)
          || (row.isSecure === 1 && site.protocol !== 'https:')) return []
        const policy = sameSite(row.sameSite)
        return [{
          url: site.origin, name: row.name, value: row.value, path: row.path,
          ...(row.host === '.' + site.hostname ? { domain: '.' + site.hostname } : {}),
          secure: row.isSecure === 1, httpOnly: row.isHttpOnly === 1,
          expirationDate: row.expiry / scale,
          // Chromium rejects insecure SameSite=None cookies; leave those at its default.
          sameSite: policy === 'no_restriction' && row.isSecure !== 1 ? 'unspecified' : policy,
        }]
      })
    } finally {
      db.close()
    }
  } catch (_error: unknown) {
    // Driver diagnostics can include private file paths or row data.
    throw new WebsiteProfileError('session-import-failed', 'Firefox cookie database could not be read')
  }
  if (cookies.length === 0) throw new WebsiteProfileError('session-import-empty', 'No matching Firefox cookies')
  return cookies
}
