/** Owned Electron cookie store reproducing the startup request-header overflow. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { app, session, net } from 'electron'

const [root, origin] = process.argv.slice(2)
app.setPath('userData', join(root, 'user-data'))
async function main() {
  await app.whenReady()
  const { pruneDesktopHostCookies } = await import(pathToFileURL(join(root, 'host-cookies.mjs')).href)
  const store = session.defaultSession.cookies
  const name = id => `dsh-auth-${createHash('sha256').update(id).digest('base64url')}`
  const active = name('current')
  for (let index = 0; index < 71; index++) {
    await store.set({ url: origin, name: name(`old-${index}`), value: 'x'.repeat(200), httpOnly: true })
  }
  await store.set({ url: origin, name: active, value: 'current' })
  await store.set({ url: origin, name: 'site-preference', value: 'retained' })
  await store.set({ url: 'https://unrelated.invalid', name: 'site-session', value: 'retained' })
  const profile = session.fromPartition('persist:website-fixture').cookies
  await profile.set({ url: origin, name: name('website'), value: 'retained' })
  const before = await net.fetch(origin, { credentials: 'include' })
  await before.body?.cancel()
  assert.equal(before.status, 431, 'Seeded startup cookies must exceed the real HTTP parser limit')
  await pruneDesktopHostCookies(`${origin}/?token=synthetic`, `${active}=current`, store)
  const after = await net.fetch(origin, { credentials: 'include' })
  await after.body?.cancel()
  assert.equal(after.status, 200, 'Startup must succeed after retiring obsolete internal cookies')
  assert.deepEqual((await store.get({ url: origin })).map(cookie => cookie.name).sort(), [active, 'site-preference'].sort())
  assert.equal((await store.get({ url: 'https://unrelated.invalid' }))[0].value, 'retained')
  assert.equal((await profile.get({ url: origin }))[0].value, 'retained')
  await pruneDesktopHostCookies(origin, `${active}=current`, store)
  assert.equal((await store.get({ url: origin })).length, 2)
  console.log('HOST_COOKIE_RECOVERY_OK')
  app.exit(0)
}
void main().catch((error) => {
  console.error(error)
  app.exit(1)
})
