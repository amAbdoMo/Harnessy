/** Main-only, site-scoped migration from a user-selected Helium profile. */
import { createDecipheriv, createHash, timingSafeEqual } from 'node:crypto'
import { open, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { CookiesSetDetails } from 'electron'
import koffi from 'koffi'
import { canImportWebsiteCookies, importedWebsiteCookie, MAX_COOKIE_DATABASE_BYTES, MAX_SITE_COOKIES } from './website-cookie-import.ts'
import { WebsiteProfileError } from './website-profile-errors.ts'

const CHROMIUM_EPOCH_MICROS = 11644473600000000n
const MAX_LOCAL_STATE_BYTES = 4 * 1024 * 1024
const KEY_BYTES = 32
const NONCE_BYTES = 12
const TAG_BYTES = 16
const LEGACY_PREFIX = Buffer.from('v10')
const DPAPI_PREFIX = Buffer.from('DPAPI')
const CRYPTPROTECT_UI_FORBIDDEN = 1

function unsupportedProtection(): WebsiteProfileError {
  return new WebsiteProfileError('session-import-protection', 'Helium session protection cannot be migrated')
}

function unprotectProfileKey(encrypted: Buffer): Buffer {
  const crypt32 = koffi.load('crypt32.dll')
  const kernel32 = koffi.load('kernel32.dll')
  const blob = koffi.struct({ length: 'uint32', bytes: 'void *' })
  const unprotect = crypt32.func('__stdcall', 'CryptUnprotectData', 'int',
    [koffi.pointer(blob), 'void *', 'void *', 'void *', 'void *', 'uint32', koffi.out(koffi.pointer(blob))])
  const free = kernel32.func('void * __stdcall LocalFree(void *memory)')
  const keyBytes = koffi.array('uint8', KEY_BYTES, 'Typed')
  const output: { length: number; bytes: unknown } = { length: 0, bytes: null }
  try {
    const ok = unprotect({ length: encrypted.length, bytes: encrypted }, null, null, null, null, CRYPTPROTECT_UI_FORBIDDEN, output)
    if (!ok || output.bytes === null || output.length !== KEY_BYTES) throw unsupportedProtection()
    // Electron disallows unmanaged ArrayBuffer views, so the codec copies the native key bytes.
    const plain: unknown = koffi.decode(output.bytes, keyBytes)
    if (!(plain instanceof Uint8Array)) throw unsupportedProtection()
    try { return Buffer.from(plain) } finally { plain.fill(0) }
  } finally {
    if (output.bytes !== null) {
      try {
        if (output.length === KEY_BYTES) koffi.encode(output.bytes, keyBytes, new Uint8Array(KEY_BYTES))
      } finally { free(output.bytes) }
    }
  }
}

async function loadProfileKey(profile: string): Promise<Buffer> {
  const file = await open(join(dirname(profile), 'Local State'), 'r')
  const bytes = Buffer.alloc(MAX_LOCAL_STATE_BYTES + 1)
  let document: unknown
  try {
    const info = await file.stat()
    if (!info.isFile() || info.size > MAX_LOCAL_STATE_BYTES) throw new Error('Unexpected Helium Local State')
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0)
    if (bytesRead > MAX_LOCAL_STATE_BYTES) throw new Error('Unexpected Helium Local State size')
    document = JSON.parse(bytes.toString('utf8', 0, bytesRead))
  } finally { bytes.fill(0); await file.close() }
  if (typeof document !== 'object' || document === null || !('os_crypt' in document)) throw unsupportedProtection()
  const config = document.os_crypt
  if (typeof config !== 'object' || config === null || !('encrypted_key' in config)
    || typeof config.encrypted_key !== 'string' || config.encrypted_key.length > 4096) throw unsupportedProtection()
  const key = Buffer.from(config.encrypted_key, 'base64')
  if (key.length <= DPAPI_PREFIX.length || !key.subarray(0, DPAPI_PREFIX.length).equals(DPAPI_PREFIX)) throw unsupportedProtection()
  return unprotectProfileKey(key.subarray(DPAPI_PREFIX.length))
}

function decryptCookie(protectedValue: Buffer, key: Buffer, host: string): string {
  const nonceEnd = LEGACY_PREFIX.length + NONCE_BYTES
  const tagStart = protectedValue.length - TAG_BYTES
  if (tagStart <= nonceEnd) throw new Error('Helium encrypted value is truncated')
  const decipher = createDecipheriv('aes-256-gcm', key, protectedValue.subarray(LEGACY_PREFIX.length, nonceEnd))
  decipher.setAuthTag(protectedValue.subarray(tagStart))
  const plain = decipher.update(protectedValue.subarray(nonceEnd, tagStart))
  try {
    decipher.final()
    const siteDigest = createHash('sha256').update(host).digest()
    if (plain.length < siteDigest.length || !timingSafeEqual(plain.subarray(0, siteDigest.length), siteDigest)) {
      throw new Error('Helium cookie is bound to a different hostname')
    }
    return new TextDecoder('utf-8', { fatal: true }).decode(plain.subarray(siteDigest.length))
  } finally { plain.fill(0) }
}

/** Read one consented website from the selected Helium profile without modifying the source.
 * @param profile - profile folder chosen through the Windows picker.
 * @param site - exact destination confirmed by the user.
 * @returns settings for the site's separate persistent partition.
 */
export async function readHeliumWebsiteCookies(profile: string, site: URL): Promise<readonly CookiesSetDetails[]> {
  if (!canImportWebsiteCookies(site)) throw new WebsiteProfileError('session-import-site', 'Sign-in import requires a secure website')
  let key: Buffer | undefined
  try {
    const filename = join(profile, 'Network', 'Cookies')
    const info = await stat(filename)
    if (!info.isFile() || info.size > MAX_COOKIE_DATABASE_BYTES) throw new Error('Unexpected Helium cookies database')
    const db = new DatabaseSync(filename, { readOnly: true, allowExtension: false })
    try {
      db.exec('PRAGMA trusted_schema=OFF')
      for (const name of ['cookies', 'meta']) {
        if (db.prepare("SELECT type FROM pragma_table_list(?) WHERE schema = 'main'").get(name)?.type !== 'table') {
          throw new Error('Unexpected Helium cookies schema')
        }
      }
      if (Number(db.prepare("SELECT value FROM meta WHERE key = 'version'").get()?.value) !== 24) {
        throw new Error('Unsupported Helium cookies schema version')
      }
      const rows = db.prepare(`SELECT name, value, encrypted_value, host_key, path, is_secure, is_httponly, samesite,
        (expires_utc - ?) / 1000000.0 AS expiry
        FROM cookies WHERE host_key COLLATE BINARY IN (?, ?) AND expires_utc > ? AND is_persistent = 1 AND top_frame_site_key = ''
        AND length(path) <= 1024 AND length(name) + length(value) <= 4096 AND length(encrypted_value) <= 4159
        LIMIT ?`).all(CHROMIUM_EPOCH_MICROS, site.hostname, '.' + site.hostname,
        CHROMIUM_EPOCH_MICROS + BigInt(Date.now()) * 1000n, MAX_SITE_COOKIES + 1)
      if (rows.length > MAX_SITE_COOKIES) throw new Error('Too many Helium cookies for one site')
      const cookies: CookiesSetDetails[] = []
      for (const row of rows) {
        if (typeof row.host_key !== 'string' || typeof row.expiry !== 'number' || !(row.encrypted_value instanceof Uint8Array)) continue
        let value = row.value
        if (row.encrypted_value.length > 0) {
          if (value !== '') continue
          const protectedValue = Buffer.from(row.encrypted_value)
          if (!protectedValue.subarray(0, LEGACY_PREFIX.length).equals(LEGACY_PREFIX)) throw unsupportedProtection()
          key ??= await loadProfileKey(profile)
          value = decryptCookie(protectedValue, key, row.host_key)
        }
        const cookie = importedWebsiteCookie(site, {
          host: row.host_key, name: row.name, value, path: row.path, expirationDate: row.expiry,
          secure: row.is_secure, httpOnly: row.is_httponly, sameSite: row.samesite,
        })
        if (cookie !== undefined) cookies.push(cookie)
      }
      if (cookies.length === 0) throw new WebsiteProfileError('session-import-empty', 'No matching Helium cookies')
      return cookies
    } finally { db.close() }
  } catch (error: unknown) {
    if (error instanceof WebsiteProfileError) throw error
    throw new WebsiteProfileError('session-import-failed', 'Helium cookie profile could not be read')
  } finally { key?.fill(0) }
}
