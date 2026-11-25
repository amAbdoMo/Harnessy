// @vitest-environment jsdom
import { expect, it } from 'vitest'
import { MAX_BROWSER_PROFILE_IMPORT_BYTES, parseBrowserProfileImport } from '../src/client/browser/profile-import.ts'

const ORIGIN = 'https://app.example.test'

it('reads safe, distinct sites from a bookmark export without adopting its markup', () => {
  const source = `<!DOCTYPE NETSCAPE-Bookmark-file-1>
    <DL>
      <DT><A HREF="https://site.example/path">Work &amp; personal</A>
      <DT><A HREF="https://site.example/path">Duplicate</A>
      <DT><A HREF="https://name:secret@invalid.example/">Credentials</A>
      <DT><A HREF="https://invalid.example/?token=secret">Query</A>
      <DT><A HREF="https://invalid.example/#foo">Fragment</A>
      <DT><A HREF="https://app.example.test/private">Application origin</A>
      <DT><A HREF="file:///private">File</A>
      <DT><A HREF="http://localhost:3000">Local address</A>
      <script>document.body.dataset.bookmarkRan = '1'</script>
      <iframe src="https://never-open.example/"></iframe>
    </DL>`
  expect(parseBrowserProfileImport(source, ORIGIN)).toEqual([
    { name: 'Work & personal', url: 'https://site.example/path' },
    { name: 'Local address', url: 'http://localhost:3000/' },
  ])
  expect(document.querySelector('iframe')).toBeNull()
  expect(document.body.dataset.bookmarkRan).toBeUndefined()
})

it('accepts portable name and URL records and rejects unsupported or oversized files', () => {
  const site = { name: 'Work', url: 'https://site.example' }
  expect(parseBrowserProfileImport(JSON.stringify({ version: 1, profiles: [site] }), ORIGIN))
    .toEqual([{ ...site, url: 'https://site.example/' }])
  expect(parseBrowserProfileImport(JSON.stringify({ version: 1, profiles: [{ ...site, cookie: 'unsupported' }] }), ORIGIN)).toBeUndefined()
  expect(parseBrowserProfileImport(JSON.stringify({ version: 2, profiles: [site] }), ORIGIN)).toBeUndefined()
  expect(parseBrowserProfileImport('x'.repeat(MAX_BROWSER_PROFILE_IMPORT_BYTES + 1), ORIGIN)).toBeUndefined()
})

it('bounds the list of candidates shown to the user', () => {
  const profiles = Array.from({ length: 101 }, (_, i) => ({ name: 'Site', url: `https://site.example/${i}` }))
  const sites = parseBrowserProfileImport(JSON.stringify({ version: 1, profiles }), ORIGIN)
  expect(sites).toHaveLength(100)
  expect(sites?.at(-1)?.url).toBe('https://site.example/99')
})
