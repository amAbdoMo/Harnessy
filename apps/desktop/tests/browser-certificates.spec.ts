import { X509Certificate } from 'node:crypto'
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
          "warning": "This device’s certificate issuer cannot be verified or its name does not match this address. An attacker could impersonate the device. Continue only if you recognize the device, have verified its fingerprint, and trust this network.",
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
          "warning": "无法验证此设备的证书颁发者，或其名称与此地址不匹配。攻击者可能冒充该设备。只有在认识此设备、已核实其指纹并信任当前网络时才继续",
        },
      ]
    `)
})

// Signed test leaves, valid 2020–2040, deliberately lacking the router's IP SAN. No private key is retained.
const certificateOne = `-----BEGIN CERTIFICATE-----
MIIBKjCCAM+gAwIBAgIBATAKBggqhkjOPQQDAjAeMRwwGgYDVQQDDBNyb3V0ZXIu
ZXhhbXBsZS50ZXN0MB4XDTIwMDEwMTAwMDAwMFoXDTQwMDEwMTAwMDAwMFowHjEc
MBoGA1UEAwwTcm91dGVyLmV4YW1wbGUudGVzdDBZMBMGByqGSM49AgEGCCqGSM49
AwEHA0IABOWBuGtj0luoknttr0mDMO3rVbrjPKxVVHXdQvMuStYPtyIquPu3TGr2
qL3KJAF4N13Cba44jdaSJ/9c1xGf9qswCgYIKoZIzj0EAwIDSQAwRgIhAM0GK22T
6WMJl84cVYj6KnrIxY1y8CKnnLsm7dNWZ/xTAiEApekUyZaIGvkXYzwUNxVFl7nn
3arjFjLF5XOrMkOPIw0=
-----END CERTIFICATE-----`
const certificateTwo = `-----BEGIN CERTIFICATE-----
MIIBKTCCAM+gAwIBAgIBAjAKBggqhkjOPQQDAjAeMRwwGgYDVQQDDBNyb3V0ZXIu
ZXhhbXBsZS50ZXN0MB4XDTIwMDEwMTAwMDAwMFoXDTQwMDEwMTAwMDAwMFowHjEc
MBoGA1UEAwwTcm91dGVyLmV4YW1wbGUudGVzdDBZMBMGByqGSM49AgEGCCqGSM49
AwEHA0IABOWBuGtj0luoknttr0mDMO3rVbrjPKxVVHXdQvMuStYPtyIquPu3TGr2
qL3KJAF4N13Cba44jdaSJ/9c1xGf9qswCgYIKoZIzj0EAwIDSAAwRQIhALxolLv1
ABk6aVyFSzdf0yp1Z1AQDYcdkkuTqvQqyMeOAiAClD02XHJfin+nWj9ANaqJQB2Y
5eDhEP9xsax9Jvr7Rg==
-----END CERTIFICATE-----`
type CertificateFixture = Pick<Electron.Certificate, 'data' | 'fingerprint' | 'validStart' | 'validExpiry'>
function nativeCertificate(pem: string): CertificateFixture {
  const leaf = new X509Certificate(pem)
  const fingerprint = `sha256/${Buffer.from(leaf.fingerprint256.replaceAll(':', ''), 'hex').toString('base64')}`
  return { data: pem, fingerprint,
    validStart: leaf.validFromDate.getTime() / 1000, validExpiry: leaf.validToDate.getTime() / 1000 }
}
const leaves = { 'certificate-one': nativeCertificate(certificateOne), 'certificate-two': nativeCertificate(certificateTwo) }
const fingerprintOne = new X509Certificate(certificateOne).fingerprint256
const fingerprintTwo = new X509Certificate(certificateTwo).fingerprint256

function fixture(confirm: ConfirmBrowserCertificate = async () => true) {
  const guest = Object.assign(new EventEmitter(), { isLoading: vi.fn(() => true) })
  // Native event fixtures expose only the members this policy consumes.
  const owner = {} as WebContents
  const eligible = vi.fn((_url: string) => true)
  const prompt = vi.fn(confirm)
  const onAnswer = vi.fn<(trusted: boolean) => void>()
  const bindFixture = bindBrowserCertificateErrors as (
    guest: EventEmitter & Pick<WebContents, 'isLoading'>, owner: WebContents,
    eligible: Parameters<typeof bindBrowserCertificateErrors>[2], confirm: ConfirmBrowserCertificate,
  ) => ReturnType<typeof bindBrowserCertificateErrors>
  const dispose = bindFixture(guest, owner, eligible, prompt)
  onTestFinished(dispose)
  const navigate = (url: string) => guest.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false, url })
  const failure = (url: string, mainFrame = true, error = 'net::ERR_CERT_AUTHORITY_INVALID', certificate: keyof typeof leaves | CertificateFixture = 'certificate-one') => {
    const event = { preventDefault: vi.fn() } as Pick<Event, 'preventDefault'>
    const callback = vi.fn((trusted: boolean) => { onAnswer(trusted) })
    guest.emit('certificate-error', event, url, error, typeof certificate === 'string' ? leaves[certificate] : certificate, callback, mainFrame)
    return callback
  }
  return { guest, owner, eligible, prompt, navigate, failure, dispose, onAnswer }
}

it.each([
  { name: 'Electron SHA-256 base64', fingerprint: leaves['certificate-one'].fingerprint },
  { name: 'colon-separated hexadecimal', fingerprint: fingerprintOne },
  { name: 'plain lowercase hexadecimal', fingerprint: fingerprintOne.replaceAll(':', '').toLowerCase() },
])('canonicalizes the verified native $name fingerprint for human consent', async ({ fingerprint }) => {
  const f = fixture()
  const url = 'https://192.168.1.1/'
  f.navigate(url)
  const answer = f.failure(url, true, undefined, { ...leaves['certificate-one'], fingerprint })
  await vi.waitFor(() => { expect(answer).toHaveBeenCalledExactlyOnceWith(true) })
  expect(f.prompt.mock.calls[0]?.[0].fingerprint).toBe(fingerprintOne)
})

it.each(['https://192.168.1.1/', 'https://10.0.0.1/', 'https://172.16.0.1/', 'https://172.31.255.255/',
  'https://169.254.0.1/', 'https://127.0.0.1:1234/', 'https://localhost:1234/', 'https://[::1]/',
  'https://[fd00::1]/', 'https://[fe80::1]/'])('asks before accepting the exact local connection %s', async (url) => {
  const f = fixture()
  f.navigate(url)
  const answer = f.failure(url)
  expect(answer).not.toHaveBeenCalled()
  await vi.waitFor(() => { expect(answer).toHaveBeenCalledExactlyOnceWith(true) })
  expect(f.prompt).toHaveBeenCalledOnce()
  const input = f.prompt.mock.calls[0]?.[0]
  expect(input).toBeDefined()
  if (input === undefined) throw new Error('Expected certificate confirmation')
  expect(input.owner).toBe(f.owner)
  expect(input.origin).toBe(new URL(url).origin)
  expect(input.fingerprint).toBe(fingerprintOne)
})

it.each(['https://example.com/', 'https://8.8.8.8/', 'https://172.15.0.1/', 'https://172.32.0.1/',
  'https://[2001:db8::1]/', 'https://router.local/', 'https://user:password@192.168.1.1/', 'http://192.168.1.1/',
  'file:///fixture', 'invalid'])('does not offer a local exception for %s', (url) => {
  const f = fixture()
  f.navigate(url)
  expect(f.failure(url)).toHaveBeenCalledExactlyOnceWith(false)
  expect(f.prompt).not.toHaveBeenCalled()
})

it.each(['net::ERR_CERT_REVOKED', 'net::ERR_CERT_DATE_INVALID', 'net::ERR_CERT_INVALID', 'net::ERR_SSL_PROTOCOL_ERROR'])('does not bypass %s', (error) => {
  const f = fixture()
  f.navigate('https://192.168.1.1/')
  expect(f.failure('https://192.168.1.1/', true, error)).toHaveBeenCalledExactlyOnceWith(false)
  expect(f.prompt).not.toHaveBeenCalled()
})

it.each(['net::ERR_CERT_REVOKED', 'net::ERR_CERT_DATE_INVALID', 'net::ERR_CERT_INVALID', 'net::ERR_SSL_PROTOCOL_ERROR'])(
  'does not reuse an approved fingerprint to bypass %s', async (error) => {
    const f = fixture()
    f.navigate('https://192.168.1.1/')
    const approved = f.failure('https://192.168.1.1/')
    await vi.waitFor(() => { expect(approved).toHaveBeenCalledExactlyOnceWith(true) })
    expect(f.failure('https://192.168.1.1/', true, error)).toHaveBeenCalledExactlyOnceWith(false)
    expect(f.failure('https://192.168.1.1/app.js', false, error)).toHaveBeenCalledExactlyOnceWith(false)
    expect(f.failure('https://192.168.1.1/app.js', false)).toHaveBeenCalledExactlyOnceWith(true)
    expect(f.prompt).toHaveBeenCalledOnce()
  },
)

it.each(['net::ERR_CERT_AUTHORITY_INVALID', 'net::ERR_CERT_COMMON_NAME_INVALID'])(
  'requires manual consent, never automatic name/authority trust for %s', async (error) => {
    const decision = Promise.withResolvers<boolean>()
    const f = fixture(() => decision.promise)
    const url = 'https://192.168.1.1/'
    f.navigate(url)
    expect(f.failure(url, false, error)).toHaveBeenCalledExactlyOnceWith(false)
    const answer = f.failure(url, true, error)
    await vi.waitFor(() => { expect(f.prompt).toHaveBeenCalledOnce() })
    expect(answer).not.toHaveBeenCalled()
    decision.resolve(false)
    await vi.waitFor(() => { expect(answer).toHaveBeenCalledExactlyOnceWith(false) })
    f.prompt.mockResolvedValue(true)
    const retry = f.failure(url, true, error)
    await vi.waitFor(() => { expect(retry).toHaveBeenCalledExactlyOnceWith(true) })
    const otherError = error === 'net::ERR_CERT_AUTHORITY_INVALID' ? 'net::ERR_CERT_COMMON_NAME_INVALID' : 'net::ERR_CERT_AUTHORITY_INVALID'
    expect(f.failure(`${url}app.js`, false, otherError)).toHaveBeenCalledExactlyOnceWith(true)
    expect(f.prompt).toHaveBeenCalledTimes(2)
  },
)

it.each([
  { kind: 'malformed PEM', certificate: { ...leaves['certificate-one'], data: 'certificate-one' } },
  { kind: 'missing fingerprint', certificate: { ...leaves['certificate-one'], fingerprint: '' } },
  { kind: 'malformed fingerprint', certificate: { ...leaves['certificate-one'], fingerprint: 'native-fingerprint:certificate-one' } },
  { kind: 'other leaf fingerprint', certificate: { ...leaves['certificate-one'], fingerprint: fingerprintTwo } },
  { kind: 'wrong native digest', certificate: { ...leaves['certificate-one'], fingerprint: leaves['certificate-two'].fingerprint } },
  { kind: 'native digest without padding', certificate: { ...leaves['certificate-one'], fingerprint: leaves['certificate-one'].fingerprint.slice(0, -1) } },
  { kind: 'native digest with trailing data', certificate: { ...leaves['certificate-one'], fingerprint: `${leaves['certificate-one'].fingerprint}extra` } },
  { kind: 'unsupported native digest algorithm', certificate: { ...leaves['certificate-one'], fingerprint: leaves['certificate-one'].fingerprint.replace('sha256/', 'sha1/') } },
  { kind: 'native start mismatch', certificate: { ...leaves['certificate-one'], validStart: 1 } },
  { kind: 'native expiry mismatch', certificate: { ...leaves['certificate-one'], validExpiry: Infinity } },
])('denies $kind and withdraws same-origin pending consent', async ({ certificate }) => {
  const decision = Promise.withResolvers<boolean>()
  const f = fixture(() => decision.promise)
  const url = 'https://192.168.1.1/'
  f.navigate(url)
  const pending = f.failure(url)
  await vi.waitFor(() => { expect(f.prompt).toHaveBeenCalledOnce() })
  expect(f.failure(url, true, undefined, certificate)).toHaveBeenCalledExactlyOnceWith(false)
  expect(pending).toHaveBeenCalledExactlyOnceWith(false)
  expect(f.prompt.mock.calls[0]?.[0].signal.aborted).toBe(true)
  decision.resolve(true)
  await new Promise<undefined>(resolve => setImmediate(() => { resolve(undefined) }))
  expect(f.failure(`${url}app.js`, false)).toHaveBeenCalledExactlyOnceWith(false)
  expect(f.prompt).toHaveBeenCalledOnce()
})

it('withdraws existing approval after an uncertain native leaf instead of trusting its unchecked fingerprint', async () => {
  const f = fixture()
  const url = 'https://192.168.1.1/'
  f.navigate(url)
  const first = f.failure(url)
  await vi.waitFor(() => { expect(first).toHaveBeenCalledExactlyOnceWith(true) })
  expect(f.failure(`${url}app.js`, false, undefined, { ...leaves['certificate-one'], data: 'malformed' }))
    .toHaveBeenCalledExactlyOnceWith(false)
  expect(f.failure(`${url}app.js`, false)).toHaveBeenCalledExactlyOnceWith(false)
  const retry = f.failure(url)
  await vi.waitFor(() => { expect(retry).toHaveBeenCalledExactlyOnceWith(true) })
  expect(f.prompt).toHaveBeenCalledTimes(2)
})

it.each([
  ['not yet valid', '2019-12-31T23:59:59Z', false],
  ['valid start', '2020-01-01T00:00:00Z', true],
  ['valid expiry', '2040-01-01T00:00:00Z', false],
  ['expired', '2040-01-01T00:00:01Z', false],
] as const)('checks real PEM dates when authority-invalid masks %s', async (_kind, now, accepted) => {
  const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.parse(now))
  onTestFinished(() => { clock.mockRestore() })
  const f = fixture()
  const url = 'https://192.168.1.1/'
  f.navigate(url)
  const answer = f.failure(url)
  await vi.waitFor(() => { expect(answer).toHaveBeenCalledExactlyOnceWith(accepted) })
  expect(f.prompt).toHaveBeenCalledTimes(accepted ? 1 : 0)
})

it.each(['pending', 'approved'] as const)('rejects a leaf expiring while consent is %s', async (phase) => {
  const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2039-12-31T23:59:59Z'))
  onTestFinished(() => { clock.mockRestore() })
  const decision = Promise.withResolvers<boolean>()
  const f = fixture(() => decision.promise)
  const url = 'https://192.168.1.1/'
  f.navigate(url)
  const answer = f.failure(url)
  await vi.waitFor(() => { expect(f.prompt).toHaveBeenCalledOnce() })
  if (phase === 'approved') {
    decision.resolve(true)
    await vi.waitFor(() => { expect(answer).toHaveBeenCalledExactlyOnceWith(true) })
  }
  clock.mockReturnValue(Date.parse('2040-01-01T00:00:00Z'))
  if (phase === 'pending') {
    decision.resolve(true)
    await vi.waitFor(() => { expect(answer).toHaveBeenCalledExactlyOnceWith(false) })
  }
  expect(f.failure(`${url}app.js`, false)).toHaveBeenCalledExactlyOnceWith(false)
  expect(f.prompt).toHaveBeenCalledOnce()
})

it('denies pending consent if the clock moves before the parsed leaf valid start', async () => {
  const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2020-01-01T00:00:00Z'))
  onTestFinished(() => { clock.mockRestore() })
  const decision = Promise.withResolvers<boolean>()
  const f = fixture(() => decision.promise)
  const url = 'https://192.168.1.1/'
  f.navigate(url)
  const answer = f.failure(url)
  await vi.waitFor(() => { expect(f.prompt).toHaveBeenCalledOnce() })
  clock.mockReturnValue(Date.parse('2019-12-31T23:59:59Z'))
  decision.resolve(true)
  await vi.waitFor(() => { expect(answer).toHaveBeenCalledExactlyOnceWith(false) })
})

it('denies subframes, obsolete URLs, ineligible leases, and the default cancel decision', async () => {
  const f = fixture(async () => false)
  f.navigate('https://192.168.1.1/')
  expect(f.failure('https://192.168.1.1/', false)).toHaveBeenCalledExactlyOnceWith(false)
  expect(f.failure('https://192.168.1.1/app.js', false)).toHaveBeenCalledExactlyOnceWith(false)
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
    const duplicate = f.failure('https://192.168.1.1/')
    await vi.waitFor(() => { expect(f.prompt).toHaveBeenCalledOnce() })
    if (change === 'navigate') f.navigate('https://192.168.1.2/')
    else if (change === 'redirect') f.guest.emit('will-redirect', {}, 'https://192.168.1.2/', false, true)
    else if (change === 'destroy') f.guest.emit('destroyed')
    else if (change === 'crash') f.guest.emit('render-process-gone')
    else if (change === 'dispose') f.dispose()
    else f.eligible.mockReturnValue(false)
    decision.resolve(true)
    await new Promise<undefined>(resolve => setImmediate(() => { resolve(undefined) }))
    expect(answer).toHaveBeenCalledExactlyOnceWith(false)
    expect(duplicate).toHaveBeenCalledExactlyOnceWith(false)
  },
)

it('reuses only this live guest approval for same-certificate later requests, paths, resources and reloads', async () => {
  const f = fixture()
  f.navigate('https://192.168.1.1/')
  const first = f.failure('https://192.168.1.1/')
  await vi.waitFor(() => { expect(first).toHaveBeenCalledExactlyOnceWith(true) })
  f.guest.isLoading.mockReturnValue(false)
  f.guest.emit('did-stop-loading')
  expect(f.failure('https://192.168.1.1/')).toHaveBeenCalledExactlyOnceWith(true)
  expect(f.failure('https://192.168.1.1/assets/app.js', false)).toHaveBeenCalledExactlyOnceWith(true)
  f.navigate('https://192.168.1.1/settings')
  expect(f.failure('https://192.168.1.1/settings')).toHaveBeenCalledExactlyOnceWith(true)
  f.navigate('https://192.168.1.1/settings')
  expect(f.failure('https://192.168.1.1/settings')).toHaveBeenCalledExactlyOnceWith(true)
  expect(f.failure('https://192.168.1.2/assets/app.js', false)).toHaveBeenCalledExactlyOnceWith(false)
  expect(f.failure('https://192.168.1.1:444/assets/app.js', false)).toHaveBeenCalledExactlyOnceWith(false)
  f.eligible.mockReturnValue(false)
  expect(f.failure('https://192.168.1.1/settings')).toHaveBeenCalledExactlyOnceWith(false)
  expect(f.prompt).toHaveBeenCalledOnce()
  const other = fixture(async () => false)
  other.navigate('https://192.168.1.1/')
  const denied = other.failure('https://192.168.1.1/')
  await vi.waitFor(() => { expect(denied).toHaveBeenCalledExactlyOnceWith(false) })
})

it('withdraws a changed certificate even for resources and retains no historical fingerprint after reapproval', async () => {
  const f = fixture()
  f.navigate('https://192.168.1.1/')
  const first = f.failure('https://192.168.1.1/')
  await vi.waitFor(() => { expect(first).toHaveBeenCalledExactlyOnceWith(true) })
  expect(f.failure('https://192.168.1.1/app.js', false, undefined, 'certificate-two')).toHaveBeenCalledExactlyOnceWith(false)
  expect(f.failure('https://192.168.1.1/app.js', false)).toHaveBeenCalledExactlyOnceWith(false)
  expect(f.failure('https://192.168.1.1/other', true, undefined, 'certificate-two')).toHaveBeenCalledExactlyOnceWith(false)
  expect(f.failure('https://192.168.1.1/', true, 'net::ERR_CERT_DATE_INVALID', 'certificate-two'))
    .toHaveBeenCalledExactlyOnceWith(false)
  const changed = f.failure('https://192.168.1.1/', true, undefined, 'certificate-two')
  await vi.waitFor(() => { expect(changed).toHaveBeenCalledExactlyOnceWith(true) })
  expect(f.failure('https://192.168.1.1/app.js', false, undefined, 'certificate-two')).toHaveBeenCalledExactlyOnceWith(true)
  expect(f.failure('https://192.168.1.1/app.js', false)).toHaveBeenCalledExactlyOnceWith(false)
  expect(f.failure('https://192.168.1.1/app.js', false, undefined, 'certificate-two')).toHaveBeenCalledExactlyOnceWith(false)
  const original = f.failure('https://192.168.1.1/')
  await vi.waitFor(() => { expect(original).toHaveBeenCalledExactlyOnceWith(true) })
  expect(f.prompt.mock.calls.map(([prompt]) => prompt.fingerprint)).toEqual([
    fingerprintOne, fingerprintTwo, fingerprintOne,
  ])
})

it('does not restore withdrawn approval when consent for a replacement certificate is denied', async () => {
  const f = fixture()
  f.navigate('https://192.168.1.1/')
  const first = f.failure('https://192.168.1.1/')
  await vi.waitFor(() => { expect(first).toHaveBeenCalledExactlyOnceWith(true) })
  f.prompt.mockImplementationOnce(async () => false)
  const changed = f.failure('https://192.168.1.1/', true, undefined, 'certificate-two')
  await vi.waitFor(() => { expect(changed).toHaveBeenCalledExactlyOnceWith(false) })
  expect(f.failure('https://192.168.1.1/app.js', false)).toHaveBeenCalledExactlyOnceWith(false)
  const original = f.failure('https://192.168.1.1/')
  await vi.waitFor(() => { expect(original).toHaveBeenCalledExactlyOnceWith(true) })
  expect(f.prompt).toHaveBeenCalledTimes(3)
})

it.each([
  ['main-frame', 'https://192.168.1.1/', true, 'net::ERR_CERT_AUTHORITY_INVALID', true],
  ['resource', 'https://192.168.1.1/app.js', false, 'net::ERR_CERT_AUTHORITY_INVALID', false],
  ['ineligible resource', 'https://192.168.1.1/app.js', false, 'net::ERR_CERT_AUTHORITY_INVALID', false],
  ['off-target main-frame', 'https://192.168.1.1/other', true, 'net::ERR_CERT_AUTHORITY_INVALID', false],
  ['unsupported error', 'https://192.168.1.1/', true, 'net::ERR_CERT_DATE_INVALID', false],
] as const)('withdraws stale pending consent on a changed %s fingerprint', async (kind, url, mainFrame, error, startsDecision) => {
  const shown = Promise.withResolvers<undefined>()
  const replacementShown = Promise.withResolvers<undefined>()
  const oldDecision = Promise.withResolvers<boolean>()
  const newDecision = Promise.withResolvers<boolean>()
  const f = fixture(() => { shown.resolve(undefined); return oldDecision.promise })
  f.prompt.mockImplementationOnce(() => { shown.resolve(undefined); return oldDecision.promise })
    .mockImplementationOnce(() => { replacementShown.resolve(undefined); return newDecision.promise })
  f.navigate('https://192.168.1.1/')
  const first = f.failure('https://192.168.1.1/')
  const resource = f.failure('https://192.168.1.1/app.js', false)
  await shown.promise
  if (kind === 'ineligible resource') f.eligible.mockImplementation(address => address !== url)
  const changed = f.failure(url, mainFrame, error, 'certificate-two')
  expect(f.prompt.mock.calls[0]?.[0].signal.aborted).toBe(true)
  expect(first).toHaveBeenCalledExactlyOnceWith(false)
  expect(resource).toHaveBeenCalledExactlyOnceWith(false)
  let replacement = changed
  if (!startsDecision) {
    expect(changed).toHaveBeenCalledExactlyOnceWith(false)
    expect(f.prompt).toHaveBeenCalledOnce()
    expect(f.failure('https://192.168.1.1/app.js', false)).toHaveBeenCalledExactlyOnceWith(false)
    replacement = f.failure('https://192.168.1.1/', true, undefined, 'certificate-two')
  }
  await replacementShown.promise
  oldDecision.resolve(true)
  await new Promise<undefined>(resolve => setImmediate(() => { resolve(undefined) }))
  expect(replacement).not.toHaveBeenCalled()
  expect(first).toHaveBeenCalledExactlyOnceWith(false)
  expect(resource).toHaveBeenCalledExactlyOnceWith(false)
  newDecision.resolve(true)
  await vi.waitFor(() => { expect(replacement).toHaveBeenCalledExactlyOnceWith(true) })
  expect(f.prompt.mock.calls.map(([prompt]) => prompt.fingerprint)).toEqual([
    fingerprintOne, fingerprintTwo,
  ])
})

it.each(['navigate', 'same-url', 'dispose', 'authority', 'eligibility-error'] as const)(
  'rechecks replacement consent after stale-certificate abort callbacks cause %s loss', async (effect) => {
    const shown = Promise.withResolvers<undefined>()
    const decision = Promise.withResolvers<boolean>()
    const f = fixture(() => { shown.resolve(undefined); return decision.promise })
    f.navigate('https://192.168.1.1/')
    const first = f.failure('https://192.168.1.1/')
    const resource = f.failure('https://192.168.1.1/app.js', false)
    await shown.promise
    f.onAnswer.mockImplementationOnce(() => {
      if (effect === 'navigate') f.navigate('https://192.168.1.2/')
      else if (effect === 'same-url') f.navigate('https://192.168.1.1/')
      else if (effect === 'dispose') f.dispose()
      else if (effect === 'authority') f.eligible.mockReturnValue(false)
      else f.eligible.mockImplementation(() => { throw new Error('Ownership check failed') })
    })
    const changed = f.failure('https://192.168.1.1/', true, undefined, 'certificate-two')
    expect(first).toHaveBeenCalledExactlyOnceWith(false)
    expect(resource).toHaveBeenCalledExactlyOnceWith(false)
    expect(changed).toHaveBeenCalledExactlyOnceWith(false)
    expect(f.prompt.mock.calls[0]?.[0].signal.aborted).toBe(true)
    decision.resolve(true)
    await new Promise<undefined>(resolve => setImmediate(() => { resolve(undefined) }))
    expect(f.prompt).toHaveBeenCalledOnce()
  },
)

it.each(['accept', 'deny', 'failure', 'dispose'] as const)(
  'coalesces matching pending callbacks into one prompt and settles each once on %s', async (outcome) => {
    const shown = Promise.withResolvers<undefined>()
    const decision = Promise.withResolvers<boolean>()
    const f = fixture(() => { shown.resolve(undefined); return decision.promise })
    f.navigate('https://192.168.1.1/')
    const first = f.failure('https://192.168.1.1/')
    const duplicate = f.failure('https://192.168.1.1/')
    const resource = f.failure('https://192.168.1.1/app.js', false)
    await shown.promise
    expect(first).not.toHaveBeenCalled()
    expect(duplicate).not.toHaveBeenCalled()
    expect(resource).not.toHaveBeenCalled()
    expect(f.failure('https://192.168.1.1/other')).toHaveBeenCalledExactlyOnceWith(false)
    expect(f.failure('https://192.168.1.2/app.js', false)).toHaveBeenCalledExactlyOnceWith(false)
    expect(f.failure('https://192.168.1.1/app.js', false, 'net::ERR_CERT_DATE_INVALID')).toHaveBeenCalledExactlyOnceWith(false)
    if (outcome === 'failure') decision.reject(new Error('Native prompt failed'))
    else {
      if (outcome === 'dispose') f.dispose()
      decision.resolve(outcome !== 'deny')
    }
    // Let late prompt settlement drain after synchronous disposal callbacks.
    await new Promise<undefined>(resolve => setImmediate(() => { resolve(undefined) }))
    expect(first).toHaveBeenCalledExactlyOnceWith(outcome === 'accept')
    expect(duplicate).toHaveBeenCalledExactlyOnceWith(outcome === 'accept')
    expect(resource).toHaveBeenCalledExactlyOnceWith(outcome === 'accept')
    expect(f.prompt).toHaveBeenCalledOnce()
  },
)

it.each(['denied', 'throws'] as const)('rechecks resource URLs and drains later callbacks when eligibility %s', async (effect) => {
  const shown = Promise.withResolvers<undefined>()
  const decision = Promise.withResolvers<boolean>()
  const f = fixture(() => { shown.resolve(undefined); return decision.promise })
  const blockedUrl = 'https://192.168.1.1/assets/app.js?restricted=1'
  f.navigate('https://192.168.1.1/')
  const first = f.failure('https://192.168.1.1/')
  const blocked = f.failure(blockedUrl, false)
  const allowed = f.failure('https://192.168.1.1/assets/app.js?restricted=0', false)
  await shown.promise
  expect(blocked).not.toHaveBeenCalled()
  expect(allowed).not.toHaveBeenCalled()
  f.eligible.mockImplementation((url) => {
    if (url !== blockedUrl) return true
    if (effect === 'throws') throw new Error('Resource policy unavailable')
    return false
  })
  decision.resolve(true)
  await vi.waitFor(() => { expect(allowed).toHaveBeenCalledExactlyOnceWith(true) })
  expect(first).toHaveBeenCalledExactlyOnceWith(true)
  expect(blocked).toHaveBeenCalledExactlyOnceWith(false)
  expect(f.prompt).toHaveBeenCalledOnce()
})

it.each(['stop', 'navigate', 'dispose', 'destroy', 'crash', 'authority', 'eligibility-error', 'certificate', 'throw'] as const)(
  'keeps committed coalesced approval independent of loading events but respects native callback %s', async (effect) => {
    const decision = Promise.withResolvers<boolean>()
    const f = fixture(() => decision.promise)
    f.navigate('https://192.168.1.1/')
    let replacement: ReturnType<typeof f.failure> | undefined
    f.onAnswer.mockImplementationOnce(() => {
      if (effect === 'stop') { f.guest.isLoading.mockReturnValue(false); f.guest.emit('did-stop-loading') }
      else if (effect === 'navigate') f.navigate('https://192.168.1.1/next')
      else if (effect === 'dispose') f.dispose()
      else if (effect === 'destroy') f.guest.emit('destroyed')
      else if (effect === 'crash') f.guest.emit('render-process-gone')
      else if (effect === 'authority') f.eligible.mockReturnValue(false)
      else if (effect === 'eligibility-error') f.eligible.mockImplementationOnce(() => { throw new Error('Ownership check failed') })
      else if (effect === 'certificate') replacement = f.failure('https://192.168.1.1/app.js', false, undefined, 'certificate-two')
      else throw new Error('Native request destroyed')
    })
    const first = f.failure('https://192.168.1.1/')
    const duplicate = f.failure('https://192.168.1.1/app.js', false)
    const third = f.failure('https://192.168.1.1/app.css', false)
    decision.resolve(true)
    const retained = effect === 'stop' || effect === 'navigate' || effect === 'throw'
    await vi.waitFor(() => { expect(duplicate).toHaveBeenCalledExactlyOnceWith(retained) })
    expect(third).toHaveBeenCalledExactlyOnceWith(retained || effect === 'eligibility-error')
    expect(first).toHaveBeenCalledExactlyOnceWith(true)
    if (effect === 'certificate') expect(replacement).toHaveBeenCalledExactlyOnceWith(false)
    expect(f.prompt).toHaveBeenCalledOnce()
  },
)

it.each(['did-stop-loading', 'did-fail-load', 'did-fail-provisional-load'] as const)(
  'cancels pending consent when the current native load terminates through %s', async (event) => {
    const decision = Promise.withResolvers<boolean>()
    const f = fixture(() => decision.promise)
    f.navigate('https://192.168.1.1/')
    const answer = f.failure('https://192.168.1.1/')
    await vi.waitFor(() => { expect(f.prompt).toHaveBeenCalledOnce() })
    f.guest.isLoading.mockReturnValue(false)
    f.guest.emit(event, {}, -3, 'ERR_ABORTED', 'https://192.168.1.1/', true)
    expect(f.prompt.mock.calls[0]?.[0].signal.aborted).toBe(true)
    decision.resolve(true)
    await vi.waitFor(() => { expect(answer).toHaveBeenCalledExactlyOnceWith(false) })
  },
)

it.each(['navigation', 'changed-certificate'] as const)(
  'does not merge stale same-URL requests or lose a reentrant successor after %s cancellation', async (change) => {
    const oldDecision = Promise.withResolvers<boolean>()
    const newDecision = Promise.withResolvers<boolean>()
    const f = fixture(() => oldDecision.promise)
    f.prompt.mockImplementationOnce(() => oldDecision.promise).mockImplementationOnce(() => newDecision.promise)
    f.navigate('https://192.168.1.1/')
    const first = f.failure('https://192.168.1.1/')
    const duplicate = f.failure('https://192.168.1.1/')
    await vi.waitFor(() => { expect(f.prompt).toHaveBeenCalledOnce() })
    let successor: ReturnType<typeof f.failure> | undefined
    let replacement: ReturnType<typeof f.failure> | undefined
    const certificate = change === 'navigation' ? 'certificate-one' : 'certificate-two'
    f.onAnswer.mockImplementationOnce(() => { successor = f.failure('https://192.168.1.1/', true, undefined, certificate) })
    if (change === 'navigation') f.navigate('https://192.168.1.1/')
    else replacement = f.failure('https://192.168.1.1/', true, undefined, certificate)
    expect(first).toHaveBeenCalledExactlyOnceWith(false)
    expect(duplicate).toHaveBeenCalledExactlyOnceWith(false)
    await vi.waitFor(() => { expect(f.prompt).toHaveBeenCalledTimes(2) })
    oldDecision.resolve(true)
    await new Promise<undefined>(resolve => setImmediate(() => { resolve(undefined) }))
    expect(successor).not.toHaveBeenCalled()
    if (change === 'changed-certificate') expect(replacement).not.toHaveBeenCalled()
    newDecision.resolve(true)
    await vi.waitFor(() => { expect(successor).toHaveBeenCalledExactlyOnceWith(true) })
    if (change === 'changed-certificate') expect(replacement).toHaveBeenCalledExactlyOnceWith(true)
    expect(first).toHaveBeenCalledExactlyOnceWith(false)
    expect(duplicate).toHaveBeenCalledExactlyOnceWith(false)
  },
)

it.each(['navigate', 'authority'] as const)('does not show queued consent after pre-prompt %s loss', async (change) => {
  const f = fixture()
  f.navigate('https://192.168.1.1/')
  const answer = f.failure('https://192.168.1.1/')
  if (change === 'navigate') f.navigate('https://192.168.1.2/')
  else f.eligible.mockReturnValue(false)
  await new Promise<undefined>(resolve => setImmediate(() => { resolve(undefined) }))
  expect(answer).toHaveBeenCalledExactlyOnceWith(false)
  expect(f.prompt).not.toHaveBeenCalled()
})

it('does not retire a same-URL successor while it is still loading', async () => {
  const decision = Promise.withResolvers<boolean>()
  const f = fixture(() => decision.promise)
  f.navigate('https://192.168.1.1/')
  f.navigate('https://192.168.1.1/')
  const answer = f.failure('https://192.168.1.1/')
  await vi.waitFor(() => { expect(f.prompt).toHaveBeenCalledOnce() })
  f.guest.emit('did-fail-provisional-load', {}, -3, 'ERR_ABORTED', 'https://192.168.1.1/', true)
  f.guest.emit('did-stop-loading')
  expect(f.prompt.mock.calls[0]?.[0].signal.aborted).toBe(false)
  decision.resolve(true)
  await vi.waitFor(() => { expect(answer).toHaveBeenCalledExactlyOnceWith(true) })
})

it('withdraws every native listener when disposed', () => {
  const f = fixture()
  f.dispose()
  expect(f.guest.eventNames()).toEqual([])
})
