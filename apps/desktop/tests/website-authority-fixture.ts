/** Native request composition with Electron, profile-store and child-process adapters controlled by the test. */
import type { BrowserWindow, WebContents } from 'electron'
import type {
  DesktopBrowserLeaseId, DesktopWebsiteHostSnapshot, DesktopWebsitePageInfo, DesktopWebsiteProfile,
} from '@deepseek-ai/dsh-client-ui-sidebar-browser/types'
import { expect, onTestFinished, vi } from 'vitest'
import { DesktopHostProcess } from '../src/host-process.ts'
import { DesktopWebsiteAuthority, type DesktopWebsiteAuthorityDependencies } from '../src/website-authority.ts'

/**
 * @param retirementFailure - expected retained remote failure, asserted during teardown.
 * @returns real native authority with controllable native window/guest and private Host responses.
 */
export function websiteAuthorityFixture(retirementFailure?: Error) {
  const host = new DesktopHostProcess('node', 'runtime', 'project')
  let current: DesktopHostProcess | undefined = host
  const owner = { isDestroyed: () => false, getURL: () => 'dsh-app://app/' } as WebContents
  const nativeGuest = { isDestroyed: () => false,
    getURL: vi.fn(() => 'https://portal.example.test/current?private=secret#fragment'),
    getTitle: vi.fn(() => 'Account portal') } satisfies Pick<WebContents, 'isDestroyed' | 'getURL' | 'getTitle'>
  const guestMethods: Pick<WebContents, 'isDestroyed' | 'getURL' | 'getTitle'> = nativeGuest
  const guest = guestMethods as WebContents
  const window: Pick<BrowserWindow, 'webContents' | 'isDestroyed' | 'isVisible' | 'isMinimized'> = {
    webContents: owner, isDestroyed: () => false, isVisible: vi.fn(() => true), isMinimized: vi.fn(() => false),
  }
  const profile: DesktopWebsiteProfile = { id: 'cd1b6493-c881-4967-a544-b0a49f2d847f' as DesktopWebsiteProfile['id'],
    name: 'Portal', accountLabel: 'operator', url: 'https://portal.example.test/', mcpServerName: 'portal', control: 'human' }
  const binding = { identity: 'a'.repeat(64), endpoint: 'https://portal.example.test/mcp' }
  const lease = '8d7584ac-c562-44eb-a867-0d21e80cbb05' as DesktopBrowserLeaseId
  let snapshot: DesktopWebsiteHostSnapshot = { id: '38ac2aa4-f8ce-4b37-951c-80a4c0c117ce' as DesktopWebsiteHostSnapshot['id'],
    profile: profile.id, sessionId: 'owner-session' as DesktopWebsiteHostSnapshot['sessionId'], epoch: 1, status: 'pending' }
  let prepared: ((snapshot: DesktopWebsiteHostSnapshot) => void) | undefined
  let revoked: ((snapshot: DesktopWebsiteHostSnapshot) => void) | undefined
  let checked: ((snapshot: DesktopWebsiteHostSnapshot) => void) | undefined
  let pageInfo: ((snapshot: DesktopWebsiteHostSnapshot, signal: AbortSignal) => Promise<DesktopWebsitePageInfo>) | undefined
  let pageInfoCheck: ((snapshot: DesktopWebsiteHostSnapshot) => void) | undefined
  vi.spyOn(host, 'onWebsitePageInfo').mockImplementation((listener, check) => {
    pageInfo = listener
    pageInfoCheck = check
    return async () => { pageInfo = undefined; pageInfoCheck = undefined }
  })
  vi.spyOn(host, 'onWebsitePrepared').mockImplementation((listener) => { prepared = listener; return () => { prepared = undefined } })
  vi.spyOn(host, 'onWebsiteRevoked').mockImplementation((listener) => { revoked = listener; return () => { revoked = undefined } })
  vi.spyOn(host, 'onWebsiteCheck').mockImplementation((listener) => { checked = listener; return () => { checked = undefined } })
  const snapshots = new Map([[snapshot.id, snapshot]])
  const control = vi.spyOn(host, 'websiteControl').mockImplementation(async (command) => {
    if (command.action === 'sync' || command.action === 'drain') return undefined
    if (command.action === 'remove') { snapshots.delete(command.id); return undefined }
    const saved = snapshots.get(command.id)
    if (saved === undefined) throw new Error('Host request missing')
    const next: DesktopWebsiteHostSnapshot = { ...saved,
      status: command.action === 'validate' ? 'pending' : command.action === 'commit' ? 'granted' : 'revoked',
      epoch: command.action === 'revoke' ? saved.epoch + Number(saved.status !== 'revoked') : command.epoch }
    snapshots.set(command.id, next)
    if (command.id === snapshot.id) snapshot = next
    return next
  })
  const dependencies: DesktopWebsiteAuthorityDependencies = {
    currentHost: () => current, window: () => window, applicationUrl: 'dsh-app://app/',
    profiles: { assertAvailable: vi.fn(() => profile), binding: () => binding,
      hostInventory: async () => [{ id: profile.id, name: profile.name, accountLabel: profile.accountLabel, url: profile.url,
        serverName: profile.mcpServerName, mcpBinding: binding }] },
    guests: { inspectWebsite: vi.fn((sender, id) => sender === owner && id === lease ? { owner, guest, profile: profile.id } : undefined),
      onInvalidated: vi.fn(() => () => {}) },
  }
  const authority = new DesktopWebsiteAuthority(dependencies)
  const detachHost = authority.attachHost(host)
  onTestFinished(async () => {
    if (retirementFailure === undefined) { await authority.dispose(); await detachHost(); return }
    await expect(authority.dispose()).rejects.toMatchObject({
      message: 'Website native authority teardown failed', errors: [{ errors: [retirementFailure] }],
    })
    await expect(detachHost()).rejects.toMatchObject({
      message: 'Website Host request retirement failed', errors: [retirementFailure],
    })
  })
  return { authority, host, owner, guest, nativeGuest, window, profile, lease, dependencies, control, detachHost,
    snapshot: () => snapshot,
    pageInfo: (request: DesktopWebsiteHostSnapshot = snapshot, signal: AbortSignal = new AbortController().signal) => {
      if (pageInfo === undefined) throw new Error('Page-info listener missing')
      return pageInfo(request, signal)
    },
    pageInfoCheck: (request: DesktopWebsiteHostSnapshot = snapshot) => {
      if (pageInfoCheck === undefined) throw new Error('Page-info check listener missing')
      pageInfoCheck(request)
    },
    notifyRevocation: (request: DesktopWebsiteHostSnapshot) => {
      snapshots.set(request.id, request)
      if (request.id === snapshot.id) snapshot = request
      if (revoked === undefined) throw new Error('Revocation listener missing')
      revoked(request)
    },
    nativeCheck: (request: DesktopWebsiteHostSnapshot = snapshot) => {
      if (checked === undefined) throw new Error('Native check listener missing')
      checked(request)
    },
    prepare: (request: DesktopWebsiteHostSnapshot = snapshot) => {
      if (prepared === undefined) throw new Error('Preparation listener missing')
      prepared(request)
      snapshots.set(request.id, { ...request })
      if (request.id === snapshot.id) snapshot = { ...request }
    },
    terminate: (request: DesktopWebsiteHostSnapshot = snapshot) => {
      const terminal: DesktopWebsiteHostSnapshot = { ...request, epoch: request.epoch + 1, status: 'revoked', terminal: true }
      snapshots.set(request.id, terminal)
      if (request.id === snapshot.id) snapshot = terminal
      if (revoked === undefined) throw new Error('Revocation listener missing')
      revoked(terminal)
    },
    revoke: () => {
      snapshot = { ...snapshot, epoch: snapshot.epoch + 1, status: 'revoked' }
      snapshots.set(snapshot.id, snapshot)
      revoked?.(snapshot)
    },
    replaceHost: () => { current = new DesktopHostProcess('node', 'replacement-runtime', 'replacement-project') } }
}
