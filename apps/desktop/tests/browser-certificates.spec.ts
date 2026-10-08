import { EventEmitter } from 'node:events'
import { onTestFinished, expect, it, vi } from 'vitest'
import type { Event, WebContents } from 'electron'
import { bindBrowserCertificateErrors, type ConfirmBrowserCertificate } from '../src/browser-certificates.ts'
import { en, zh, formatDesktopMessage } from '../src/locale.ts'

it('records English and Chinese device consent with explicit risks and isolated-tab lifetime', () => {
  expect([en, zh].map(messages => ({ title: messages.browserCertificateTitle, warning: messages.browserCertificateWarning,
    detail: formatDesktopMessage(messages.browserCertificateDetail,
      { origin: 'https://192.168.1.1', fingerprint: 'fixture-fingerprint' }),
    buttons: [messages.browserCertificateContinue, messages.cancel] }))).toMatchInlineSnapshot(`
      [
        {
          "buttons": [
            "Open device in this tab (unsafe)",
            "Cancel",
          ],
          "detail": "Device: https://192.168.1.1
      Certificate fingerprint: fixture-fingerprint

      Acceptance stays in this isolated device tab until it closes, including its resources and reloads. It does not install or permanently trust the certificate.",
          "title": "Unverified local device",
          "warning": "This device’s certificate cannot be verified and may be expired or not match this address. An attacker could impersonate the device. Continue only if you recognize the device and trust this network.",
        },
        {
          "buttons": [
            "在此标签页打开设备（不安全）",
            "取消",
          ],
          "detail": "设备：https://192.168.1.1
      证书指纹：fixture-fingerprint

      接受证书仅适用于此独立设备标签页关闭前的访问，包括资源加载和重新加载，不会安装或永久信任该证书",
          "title": "未经验证的本地设备",
          "warning": "无法验证此设备的证书，它可能已过期或与此地址不匹配。攻击者可能冒充该设备。只有在认识此设备并信任当前网络时才继续",
        },
      ]
    `)
})

function fixture(confirm: ConfirmBrowserCertificate = async () => true) {
  const guest = Object.assign(new EventEmitter(), { isLoading: vi.fn(() => true) })
  // Native event fixtures expose only the members this policy consumes.
  const owner = {} as WebContents
  const eligible = vi.fn(() => true)
  const prompt = vi.fn(confirm)
  const bindFixture = bindBrowserCertificateErrors as (
    guest: EventEmitter & Pick<WebContents, 'isLoading'>, owner: WebContents,
    eligible: Parameters<typeof bindBrowserCertificateErrors>[2], confirm: ConfirmBrowserCertificate,
  ) => ReturnType<typeof bindBrowserCertificateErrors>
  const dispose = bindFixture(guest, owner, eligible, prompt)
  onTestFinished(dispose)
  const navigate = (url: string) => guest.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false, url })
  const failure = (url: string, mainFrame = true, error = 'net::ERR_CERT_AUTHORITY_INVALID', data = 'certificate-one') => {
    const event = { preventDefault: vi.fn() } as Pick<Event, 'preventDefault'>
    const callback = vi.fn()
    guest.emit('certificate-error', event, url, error, { data, fingerprint: `native-fingerprint:${data}` }, callback, mainFrame)
    return callback
  }
  return { guest, owner, eligible, prompt, navigate, failure, dispose }
}

it.each(['https://192.168.1.1/', 'https://10.0.0.1/', 'https://172.16.0.1/', 'https://172.31.255.255/',
  'https://169.254.0.1/', 'https://127.0.0.1:1234/', 'https://localhost:1234/', 'https://[::1]/',
  'https://[fd00::1]/', 'https://[fe80::1]/'])('asks before accepting the exact local connection %s', async (url) => {
  const f = fixture()
  f.navigate(url)
  const answer = f.failure(url)
  expect(answer).not.toHaveBeenCalled()
  await vi.waitFor(() => { expect(answer).toHaveBeenCalledExactlyOnceWith(true) })
  expect(f.prompt).toHaveBeenCalledOnce()
  const input = f.prompt.mock.calls[0]![0]
  expect(input.owner).toBe(f.owner)
  expect(input.origin).toBe(new URL(url).origin)
  expect(input.fingerprint).toBe('native-fingerprint:certificate-one')
})

it.each(['https://example.com/', 'https://8.8.8.8/', 'https://172.15.0.1/', 'https://172.32.0.1/',
  'https://[2001:db8::1]/', 'https://router.local/', 'https://user:password@192.168.1.1/', 'http://192.168.1.1/',
  'file:///fixture', 'invalid'])('does not offer a local exception for %s', (url) => {
  const f = fixture()
  f.navigate(url)
  expect(f.failure(url)).toHaveBeenCalledExactlyOnceWith(false)
  expect(f.prompt).not.toHaveBeenCalled()
})

it.each(['net::ERR_CERT_REVOKED', 'net::ERR_CERT_DATE_INVALID', 'net::ERR_CERT_COMMON_NAME_INVALID'])('does not bypass %s', (error) => {
  const f = fixture()
  f.navigate('https://192.168.1.1/')
  expect(f.failure('https://192.168.1.1/', true, error)).toHaveBeenCalledExactlyOnceWith(false)
  expect(f.prompt).not.toHaveBeenCalled()
})

it('denies subframes, obsolete URLs, ineligible leases, and the default cancel decision', async () => {
  const f = fixture(async () => false)
  f.navigate('https://192.168.1.1/')
  expect(f.failure('https://192.168.1.1/', false)).toHaveBeenCalledExactlyOnceWith(false)
  expect(f.failure('https://192.168.1.2/')).toHaveBeenCalledExactlyOnceWith(false)
  f.eligible.mockReturnValue(false)
  expect(f.failure('https://192.168.1.1/')).toHaveBeenCalledExactlyOnceWith(false)
  f.eligible.mockReturnValue(true)
  const answer = f.failure('https://192.168.1.1/')
  await vi.waitFor(() => { expect(answer).toHaveBeenCalledExactlyOnceWith(false) })
  expect(f.prompt).toHaveBeenCalledOnce()
})

it.each(['navigate', 'redirect', 'destroy', 'crash', 'dispose', 'authority'] as const)(
  'rejects delayed consent after %s without accepting twice', async (change) => {
    const decision = Promise.withResolvers<boolean>()
    const f = fixture(() => decision.promise)
    f.navigate('https://192.168.1.1/')
    const answer = f.failure('https://192.168.1.1/')
    await vi.waitFor(() => { expect(f.prompt).toHaveBeenCalledOnce() })
    if (change === 'navigate') f.navigate('https://192.168.1.2/')
    else if (change === 'redirect') f.guest.emit('will-redirect', {}, 'https://192.168.1.2/', false, true)
    else if (change === 'destroy') f.guest.emit('destroyed')
    else if (change === 'crash') f.guest.emit('render-process-gone')
    else if (change === 'dispose') f.dispose()
    else f.eligible.mockReturnValue(false)
    decision.resolve(true)
    await vi.waitFor(() => { expect(answer).toHaveBeenCalledExactlyOnceWith(false) })
  },
)

it('never reuses a certificate decision for another request or guest', async () => {
  const f = fixture()
  f.navigate('https://192.168.1.1/')
  const first = f.failure('https://192.168.1.1/')
  await vi.waitFor(() => { expect(first).toHaveBeenCalledExactlyOnceWith(true) })
  const changed = f.failure('https://192.168.1.1/', true, undefined, 'certificate-two')
  await vi.waitFor(() => { expect(changed).toHaveBeenCalledExactlyOnceWith(true) })
  expect(f.prompt).toHaveBeenCalledTimes(2)
  expect(f.prompt.mock.calls[0]![0].fingerprint).not.toBe(f.prompt.mock.calls[1]![0].fingerprint)
  const other = fixture(async () => false)
  other.navigate('https://192.168.1.1/')
  const denied = other.failure('https://192.168.1.1/')
  await vi.waitFor(() => { expect(denied).toHaveBeenCalledExactlyOnceWith(false) })
})

it('denies a duplicate while a confirmation is pending and contains prompt failure', async () => {
  const decision = Promise.withResolvers<boolean>()
  const f = fixture(() => decision.promise)
  f.navigate('https://192.168.1.1/')
  const first = f.failure('https://192.168.1.1/')
  const duplicate = f.failure('https://192.168.1.1/')
  expect(duplicate).toHaveBeenCalledExactlyOnceWith(false)
  decision.reject(new Error('Native prompt failed'))
  await vi.waitFor(() => { expect(first).toHaveBeenCalledExactlyOnceWith(false) })
})

it.each(['did-stop-loading', 'did-fail-load', 'did-fail-provisional-load'] as const)(
  'cancels pending consent when the current native load terminates through %s', async (event) => {
    const decision = Promise.withResolvers<boolean>()
    const f = fixture(() => decision.promise)
    f.navigate('https://192.168.1.1/')
    const answer = f.failure('https://192.168.1.1/')
    await vi.waitFor(() => { expect(f.prompt).toHaveBeenCalledOnce() })
    f.guest.isLoading.mockReturnValue(false)
    f.guest.emit(event, {}, -3, 'ERR_ABORTED', 'https://192.168.1.1/', true)
    expect(f.prompt.mock.calls[0]![0].signal.aborted).toBe(true)
    decision.resolve(true)
    await vi.waitFor(() => { expect(answer).toHaveBeenCalledExactlyOnceWith(false) })
  },
)

it('does not retire a same-URL successor while it is still loading', async () => {
  const decision = Promise.withResolvers<boolean>()
  const f = fixture(() => decision.promise)
  f.navigate('https://192.168.1.1/')
  f.navigate('https://192.168.1.1/')
  const answer = f.failure('https://192.168.1.1/')
  await vi.waitFor(() => { expect(f.prompt).toHaveBeenCalledOnce() })
  f.guest.emit('did-fail-provisional-load', {}, -3, 'ERR_ABORTED', 'https://192.168.1.1/', true)
  f.guest.emit('did-stop-loading')
  expect(f.prompt.mock.calls[0]![0].signal.aborted).toBe(false)
  decision.resolve(true)
  await vi.waitFor(() => { expect(answer).toHaveBeenCalledExactlyOnceWith(true) })
})

it('withdraws every native listener when disposed', () => {
  const f = fixture()
  f.dispose()
  expect(f.guest.eventNames()).toEqual([])
})
