/** Main-only import of ordinary persistent Firefox and Zen cookies for one approved website. */
import { stat } from 'node:fs/promises'
import { basename } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { CookiesSetDetails } from 'electron'
import { WebsiteProfileError } from './website-profile-errors.ts'
import { canImportWebsiteCookies, importedWebsiteCookie, MAX_COOKIE_DATABASE_BYTES, MAX_SITE_COOKIES } from './website-cookie-import.ts'

/**
 * Read the selected Firefox or Zen profile database without modifying it.
 * @param filename - native-picker selection, never a renderer-supplied path.
 * @param site - the approved destination. Parent domains and other sites are excluded.
 * @returns cookie settings kept in Main until they are installed in a new profile.
 */
export async function readFirefoxWebsiteCookies(filename: string, site: URL): Promise<readonly CookiesSetDetails[]> {
  if (!canImportWebsiteCookies(site)) {
    throw new WebsiteProfileError('session-import-site', 'Sign-in import requires a secure website')
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
        if (typeof row.expiry !== 'number' || !Number.isSafeInteger(row.expiry)) return []
        const cookie = importedWebsiteCookie(site, {
          host: row.host, name: row.name, value: row.value, path: row.path, expirationDate: row.expiry / scale,
          secure: row.isSecure, httpOnly: row.isHttpOnly, sameSite: row.sameSite,
        })
        return cookie === undefined ? [] : [cookie]
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
