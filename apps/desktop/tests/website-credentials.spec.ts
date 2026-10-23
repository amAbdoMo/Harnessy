/** Protected website credential persistence and conventional login coordination. */
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { JSDOM } from 'jsdom'
import { EventEmitter } from 'node:events'
import type { DesktopWebsiteProfileId } from '@deepseek-ai/dsh-client-ui-sidebar-browser/types'
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import {
  DesktopWebsiteCredentials, electronWebsiteCredentialProtector, type DesktopWebsiteCredentialProtector,
} from '../src/website-credentials.ts'
import { DesktopWebsiteLogin, electronWebsiteLoginForm } from '../src/website-login.ts'

const PROFILE = '11111111-2222-4333-8444-555555555555' as DesktopWebsiteProfileId
const OTHER = '22222222-3333-4444-8555-666666666666' as DesktopWebsiteProfileId
const SECRET = { username: 'account@example.test', password: 'not-on-disk' }
const roots: string[] = []

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function vaultPath(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-website-credentials-'))
  roots.push(root)
  return join(root, 'website-credentials.json')
}

function protector(): DesktopWebsiteCredentialProtector {
  return {
    available: async () => true,
    encrypt: async plaintext => Buffer.from(`protected:${Buffer.from(plaintext).toString('base64')}`),
    decrypt: async encrypted => Buffer.from(encrypted.toString().slice('protected:'.length), 'base64').toString(),
  }
}

describe('desktop website credentials', () => {
  it('persists only protected bytes and scopes decrypted values to a void consumer', async () => {
    const filename = await vaultPath()
    const credentials = new DesktopWebsiteCredentials(filename, protector())
    await credentials.save(PROFILE, SECRET)

    const disk = await readFile(filename, 'utf8')
    expect(disk).not.toContain(SECRET.username)
    expect(disk).not.toContain(SECRET.password)
    expect(disk).not.toContain('"username"')
    expect(await credentials.has(PROFILE)).toBe(true)

    const consume = vi.fn(async () => {})
    expect(await credentials.use(PROFILE, consume)).toBe(true)
    expect(consume).toHaveBeenCalledExactlyOnceWith(SECRET)
    expect(await credentials.use(OTHER, consume)).toBe(false)
    expect(consume).toHaveBeenCalledTimes(1)
  })

  it('refuses unavailable protection without creating a plaintext fallback', async () => {
    const filename = await vaultPath()
    const encrypt = vi.fn(async () => Buffer.from('should-not-run'))
    const credentials = new DesktopWebsiteCredentials(filename, { available: async () => false, encrypt,
      decrypt: async () => JSON.stringify(SECRET) })
    await expect(credentials.save(PROFILE, SECRET)).rejects.toThrow('Protected website credential storage is unavailable')
    expect(encrypt).not.toHaveBeenCalled()
    await expect(readFile(filename, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects Electron basic_text and delegates only to the async safeStorage API', async () => {
    const storage = {
      getSelectedStorageBackend: vi.fn(() => 'basic_text' as const),
      isAsyncEncryptionAvailable: vi.fn(async () => true),
      encryptStringAsync: vi.fn(async () => Buffer.from('encrypted')),
      decryptStringAsync: vi.fn(async () => ({ result: 'secret', shouldReEncrypt: false })),
    }
    const protectedStorage = electronWebsiteCredentialProtector(storage, 'linux')
    expect(await protectedStorage.available()).toBe(false)
    await expect(protectedStorage.encrypt('secret')).rejects.toThrow('Protected website credential storage is unavailable')
    expect(storage.isAsyncEncryptionAvailable).not.toHaveBeenCalled()
    expect(storage.encryptStringAsync).not.toHaveBeenCalled()
  })

  it('serializes replacements and retains the committed entry when encryption fails', async () => {
    const filename = await vaultPath()
    const first: PromiseWithResolvers<Buffer> = Promise.withResolvers()
    const entered: PromiseWithResolvers<void> = Promise.withResolvers()
    const encrypt = vi.fn<DesktopWebsiteCredentialProtector['encrypt']>()
      .mockImplementationOnce(async () => { entered.resolve(); return first.promise })
      .mockRejectedValueOnce(new Error('OS key unavailable'))
    const credentials = new DesktopWebsiteCredentials(filename, { available: async () => true, encrypt,
      decrypt: async value => Buffer.from(value.toString().slice('protected:'.length), 'base64').toString() })

    const saving = credentials.save(PROFILE, SECRET)
    const failing = credentials.save(PROFILE, { ...SECRET, password: 'replacement' })
    await entered.promise
    expect(encrypt).toHaveBeenCalledTimes(1)
    first.resolve(await protector().encrypt(JSON.stringify(SECRET)))
    await saving
    await expect(failing).rejects.toThrow('OS key unavailable')
    expect(encrypt).toHaveBeenCalledTimes(2)

    const consume = vi.fn(async () => {})
    await credentials.use(PROFILE, consume)
    expect(consume).toHaveBeenCalledExactlyOnceWith(SECRET)
    expect(await readFile(filename, 'utf8')).not.toContain('replacement')
  })

  it('removes only the selected protected entry', async () => {
    const filename = await vaultPath()
    const credentials = new DesktopWebsiteCredentials(filename, protector())
    await credentials.save(PROFILE, SECRET)
    await credentials.save(OTHER, { username: 'other', password: 'other-password' })
    await credentials.remove(PROFILE)
    expect(await credentials.has(PROFILE)).toBe(false)
    expect(await credentials.has(OTHER)).toBe(true)
  })
})

describe('desktop website automatic login', () => {
  function guest(html: string, url = 'https://portal.example.test/login', navigation: 'finish' | 'hold' | 'challenge' = 'finish') {
    const dom = new JSDOM(html, { url, runScripts: 'outside-only' })
    onTestFinished(() => { dom.window.close() })
    const events = new EventEmitter()
    Object.defineProperty(dom.window.HTMLElement.prototype, 'getBoundingClientRect', {
      value: () => ({ width: 100, height: 20, top: 0, right: 100, bottom: 20, left: 0, x: 0, y: 0, toJSON: () => ({}) }),
    })
    const submitted = vi.fn((event: Event) => {
      event.preventDefault()
      if (navigation === 'hold') return
      queueMicrotask(() => {
        events.emit('did-start-navigation', { isMainFrame: true })
        dom.window.document.body.innerHTML = navigation === 'challenge' ? '<input name="otp" autocomplete="one-time-code">' : '<main>Account</main>'
        events.emit('did-finish-load')
      })
    })
    dom.window.document.addEventListener('submit', submitted)
    const executeJavaScript = vi.fn(async (source: string, _userGesture?: boolean): Promise<unknown> => dom.window.eval(source))
    const contents = Object.assign(events, { isDestroyed: () => false, getURL: () => url, executeJavaScript })
    return { dom, submitted, executeJavaScript, form: electronWebsiteLoginForm(contents, 'https://portal.example.test/') }
  }

  it('fills and submits one same-origin conventional login form without returning values', async () => {
    const filename = await vaultPath()
    const credentials = new DesktopWebsiteCredentials(filename, protector())
    await credentials.save(PROFILE, SECRET)
    const page = guest('<form method="post" action="/session"><input name="email" type="email"><input name="password" type="password"><button>Continue</button></form>')
    const login = new DesktopWebsiteLogin(credentials)

    await expect(login.signInAutomatically({ id: PROFILE, url: 'https://portal.example.test/', access: 'automatic' }, page.form))
      .resolves.toBe('submitted')
    expect(page.dom.window.document.body.textContent).toBe('Account')
    expect(page.submitted).toHaveBeenCalledOnce()
    expect(page.executeJavaScript.mock.calls[0]?.[1]).toBe(true)
  })

  it.each([
    ['cross-origin action', '<form method="post" action="https://elsewhere.example.test/session"><input name="email" type="email"><input type="password"><button type="submit">Continue</button></form>'],
    ['submitter origin override', '<form method="post"><input name="email" type="email"><input type="password"><button type="submit" formaction="https://elsewhere.example.test/session">Continue</button></form>'],
    ['new-window target', '<form method="post" target="_blank"><input name="email" type="email"><input type="password"><button type="submit">Continue</button></form>'],
    ['password change', '<form method="post"><input name="email" type="email"><input type="password"><input type="password"><button type="submit">Change</button></form>'],
    ['MFA form', '<form method="post"><input name="email" type="email"><input type="password"><input name="otp"><button type="submit">Continue</button></form>'],
    ['ambiguous fields', '<form method="post"><input name="email" type="email"><input name="username" type="text"><input type="password"><button type="submit">Continue</button></form>'],
  ])('leaves %s untouched', async (_scenario, html) => {
    const filename = await vaultPath()
    const credentials = new DesktopWebsiteCredentials(filename, protector())
    await credentials.save(PROFILE, SECRET)
    const page = guest(html)
    const login = new DesktopWebsiteLogin(credentials)
    await expect(login.signInAutomatically({ id: PROFILE, url: 'https://portal.example.test/', access: 'automatic' }, page.form))
      .resolves.toBe('unavailable')
    expect(page.submitted).not.toHaveBeenCalled()
    expect([...page.dom.window.document.querySelectorAll('input')].every(input => input.value === '')).toBe(true)
  })

  it('does not decrypt or touch a form unless profile access is automatic on the saved origin', async () => {
    const filename = await vaultPath()
    const delegate = protector()
    const decrypt = vi.fn(async (value: Buffer) => delegate.decrypt(value))
    const credentials = new DesktopWebsiteCredentials(filename, { ...protector(), decrypt })
    await credentials.save(PROFILE, SECRET)
    const login = new DesktopWebsiteLogin(credentials)
    const page = guest('<form method="post"><input name="email" type="email"><input type="password"><button type="submit">Continue</button></form>')
    await expect(login.signInAutomatically({ id: PROFILE, url: 'https://portal.example.test/', access: 'ask' }, page.form))
      .resolves.toBe('not-needed')
    const redirected = electronWebsiteLoginForm(Object.assign(new EventEmitter(), { isDestroyed: () => false, getURL: () => 'https://elsewhere.example.test/login',
      executeJavaScript: page.executeJavaScript }),
    'https://portal.example.test/')
    await expect(login.signInAutomatically({ id: PROFILE, url: 'https://portal.example.test/', access: 'automatic' }, redirected))
      .resolves.toBe('unavailable')
    expect(decrypt).not.toHaveBeenCalled()
    expect(page.executeJavaScript).not.toHaveBeenCalled()
  })

  it('cancels a stalled sign-in and refuses to treat an MFA redirect as completed login', async () => {
    const credentials = new DesktopWebsiteCredentials(await vaultPath(), protector())
    await credentials.save(PROFILE, SECRET)
    const login = new DesktopWebsiteLogin(credentials)
    const html = '<form method="post"><input name="email" type="email"><input type="password"><button type="submit">Continue</button></form>'
    const page = guest(html, undefined, 'hold')
    const cancellation = new AbortController()
    const pending = login.signInAutomatically({ id: PROFILE, url: 'https://portal.example.test/', access: 'automatic' }, page.form, cancellation.signal)
    const rejected = expect(pending).rejects.toThrow('fixture cancelled')
    await vi.waitFor(() => { expect(page.submitted).toHaveBeenCalledOnce() })
    cancellation.abort(new Error('fixture cancelled'))
    await rejected
    const challenge = guest(html, undefined, 'challenge')
    await expect(login.signInAutomatically({ id: PROFILE, url: 'https://portal.example.test/', access: 'automatic' }, challenge.form))
      .resolves.toBe('unavailable')
  })
})
