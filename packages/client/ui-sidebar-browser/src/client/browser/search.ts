/** Address-bar search destinations, selected only for human-entered queries. */

const ENGINES = {
  duckduckgo: 'https://duckduckgo.com/',
  google: 'https://www.google.com/search',
  bing: 'https://www.bing.com/search',
  brave: 'https://search.brave.com/search',
  kagi: 'https://kagi.com/search',
  ecosia: 'https://www.ecosia.org/search',
} as const

/** Search engines offered in Browser settings. */
export type BrowserSearchEngine = keyof typeof ENGINES

/** Search engines in display order. */
export const BROWSER_SEARCH_ENGINES = Object.keys(ENGINES) as BrowserSearchEngine[]

/**
 * Send queries to the selected engine and leave address-like input to the normal URL validator.
 * @param input - text submitted from the native ordinary tab's address bar.
 * @param engine - selected search destination.
 * @returns a search URL or the original input for address validation.
 */
export function browserAddressSubmission(input: string, engine: BrowserSearchEngine): string {
  const text = input.trim()
  if (text === '' || /^[A-Za-z][A-Za-z\d+.-]*:/u.test(text)
    || /^\[|^localhost(?:[/?#]|$)|@/iu.test(text)
    || (!/\s/u.test(text) && /[./\\:]/u.test(text))) return input
  const url = new URL(ENGINES[engine])
  url.searchParams.set('q', text)
  return url.href
}
