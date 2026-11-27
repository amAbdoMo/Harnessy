/** Common limits and conversion for cookies copied to a newly approved site profile. */
import type { CookiesSetDetails } from 'electron'
import { localBrowserDeviceOrigin } from './browser-certificates.ts'

/** Maximum size of a selected cookie database. */
export const MAX_COOKIE_DATABASE_BYTES = 32 * 1024 * 1024
/** Maximum matching persistent cookies in one import. */
export const MAX_SITE_COOKIES = 256

/** @param site - validated landing URL. @returns whether the site can receive persistent imported cookies. */
export function canImportWebsiteCookies(site: URL): boolean {
  return (site.protocol === 'https:' && localBrowserDeviceOrigin(site.href) === undefined)
    || (site.protocol === 'http:' && site.hostname === 'localhost')
}

interface StoredCookie {
  readonly host: unknown
  readonly name: unknown
  readonly value: unknown
  readonly path: unknown
  readonly expirationDate: number
  readonly secure: unknown
  readonly httpOnly: unknown
  readonly sameSite: unknown
}

/** Convert validated source rows to target cookie settings.
 * @param site - the exact site approved in the native prompt.
 * @param row - one candidate from the source browser.
 * @returns settings for the new partition, or undefined for an invalid cookie.
 */
export function importedWebsiteCookie(site: URL, row: StoredCookie): CookiesSetDetails | undefined {
  if ((row.host !== site.hostname && row.host !== '.' + site.hostname)
    || typeof row.name !== 'string' || typeof row.value !== 'string' || Buffer.byteLength(row.name + row.value) > 4096
    || typeof row.path !== 'string' || !row.path.startsWith('/') || /[\x00-\x1f\x7f]/u.test(row.path)
    || !Number.isFinite(row.expirationDate) || row.expirationDate <= Date.now() / 1000
    || (row.secure !== 0 && row.secure !== 1) || (row.httpOnly !== 0 && row.httpOnly !== 1)
    || (row.secure === 1 && site.protocol !== 'https:')) return undefined
  const sameSite = row.sameSite === 2 ? 'strict' : row.sameSite === 1 ? 'lax'
    : row.sameSite === 0 && row.secure === 1 ? 'no_restriction' : 'unspecified'
  return {
    url: site.origin, name: row.name, value: row.value, path: row.path,
    ...(row.host === '.' + site.hostname ? { domain: '.' + site.hostname } : {}),
    secure: row.secure === 1, httpOnly: row.httpOnly === 1, expirationDate: row.expirationDate, sameSite,
  }
}
