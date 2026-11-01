/** Retire port-specific Host cookies before Chromium sends them together to loopback. */
import type { Cookies } from 'electron'

/**
 * Remove obsolete internal Host sessions from the application's default cookie jar.
 * @param url - Owned Host launch URL.
 * @param activeCookie - Cookie returned by the current Host's authenticated exchange.
 * @param cookies - Default Electron session cookie store; website partitions are separate.
 */
export async function pruneDesktopHostCookies(url: string, activeCookie: string, cookies: Pick<Cookies, 'get' | 'remove'>): Promise<void> {
  const origin = new URL(url).origin
  const activeName = activeCookie.split('=', 1)[0]
  const stored = await cookies.get({ url: origin })
  for (const cookie of stored) {
    if (cookie.name !== activeName && /^dsh-auth-[A-Za-z0-9_-]{43}$/u.test(cookie.name)) await cookies.remove(origin, cookie.name)
  }
}
