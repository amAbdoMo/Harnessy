/** Parse portable website details from a file chosen by the user. */
import { parseBrowserAddress } from './url.ts'

/** Maximum file size accepted by the browser profile importer. */
export const MAX_BROWSER_PROFILE_IMPORT_BYTES = 2 * 1024 * 1024
const MAX_IMPORTED_SITES = 100

/** The fields carried from an import into the normal profile form. */
export interface ImportedBrowserSite {
  readonly name: string
  readonly url: string
}

function site(name: string, address: string, applicationOrigin: string): ImportedBrowserSite | undefined {
  if (!/^https?:\/\//iu.test(address.trim())) return undefined
  const parsed = parseBrowserAddress(address, applicationOrigin)
  if (!parsed.ok || parsed.target.url.length > 2048 || /[?#]/u.test(parsed.target.url)) return undefined
  const title = name.replace(/[\x00-\x1f\x7f]/gu, ' ').trim().slice(0, 120)
  return { name: title || parsed.target.title.slice(0, 120), url: parsed.target.url }
}

function portableProfiles(text: string): Iterable<readonly [string, string]> | undefined {
  let data: unknown
  try { data = JSON.parse(text) }
  catch (_error: unknown) { return undefined }
  if (typeof data !== 'object' || data === null || !('version' in data) || data.version !== 1
    || !('profiles' in data) || !Array.isArray(data.profiles) || Object.keys(data).length !== 2) return undefined
  const profiles: readonly unknown[] = data.profiles
  const entries: [string, string][] = []
  for (const profile of profiles) {
    if (typeof profile !== 'object' || profile === null || Object.keys(profile).length !== 2
      || !('name' in profile) || typeof profile.name !== 'string'
      || !('url' in profile) || typeof profile.url !== 'string') return undefined
    entries.push([profile.name, profile.url])
  }
  return entries
}

function* bookmarks(text: string): Iterable<readonly [string, string]> {
  const template = document.createElement('template')
  template.innerHTML = text
  for (const anchor of template.content.querySelectorAll('a[href]')) {
    yield [anchor.textContent ?? '', anchor.getAttribute('href') ?? '']
  }
}

/**
 * Read one bookmark export or a versioned JSON file of website names and addresses.
 * Bookmark markup stays in inert template content and is never inserted into the document.
 * @param text - selected file contents.
 * @param applicationOrigin - application address excluded from the results.
 * @returns up to 100 unique, eligible sites, or undefined for an unsupported format.
 */
export function parseBrowserProfileImport(text: string, applicationOrigin: string): readonly ImportedBrowserSite[] | undefined {
  if (new TextEncoder().encode(text).byteLength > MAX_BROWSER_PROFILE_IMPORT_BYTES) return undefined
  const input = /^\s*<!DOCTYPE\s+NETSCAPE-Bookmark-file-1\s*>/iu.test(text) ? bookmarks(text) : portableProfiles(text)
  if (input === undefined) return undefined
  const sites = new Map<string, ImportedBrowserSite>()
  for (const [name, url] of input) {
    const imported = site(name, url, applicationOrigin)
    if (imported === undefined || sites.has(imported.url)) continue
    sites.set(imported.url, imported)
    if (sites.size === MAX_IMPORTED_SITES) break
  }
  return [...sites.values()]
}
