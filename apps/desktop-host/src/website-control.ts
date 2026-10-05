/** Bounded private Main-to-Host request control; IPC correlation does not replace request ownership. */
import type {
  DesktopWebsiteHostCommand, DesktopWebsiteHostProfile, DesktopWebsiteHostSnapshot,
  DesktopWebsiteProfileId, DesktopWebsiteRequestId,
} from '@deepseek-ai/dsh-client-ui-sidebar-browser/types'
import type { WebsiteRequestSnapshot, WebsiteRequestsController } from './website-requests.ts'
import { assertNever } from '@deepseek-ai/dsh-util-values'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Invalid website control object')
  return value as Record<string, unknown>
}

function profile(value: unknown): DesktopWebsiteHostProfile {
  const candidate = record(value)
  const binding = record(candidate.mcpBinding)
  if (typeof candidate.id !== 'string' || !UUID.test(candidate.id)
    || typeof candidate.name !== 'string' || candidate.name.trim().length === 0 || candidate.name.length > 120
    || /[\x00-\x1f\x7f]/.test(candidate.name)
    || typeof candidate.accountLabel !== 'string' || candidate.accountLabel.length > 120 || /[\x00-\x1f\x7f]/.test(candidate.accountLabel)
    || typeof candidate.url !== 'string' || candidate.url.length > 2048 || !URL.canParse(candidate.url)
    || typeof candidate.serverName !== 'string' || !/^[A-Za-z0-9_-]{1,32}$/.test(candidate.serverName)
    || typeof binding.identity !== 'string' || !/^[0-9a-f]{64}$/.test(binding.identity)
    || typeof binding.endpoint !== 'string' || binding.endpoint.length === 0 || binding.endpoint.length > 2048
    || /[\x00-\x1f\x7f]/.test(binding.endpoint)) throw new Error('Invalid website control pairing')
  const url = new URL(candidate.url)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('Website control address contains unsupported navigation or authentication data')
  }
  return { id: candidate.id as DesktopWebsiteProfileId, name: candidate.name, accountLabel: candidate.accountLabel,
    url: url.href, serverName: candidate.serverName, mcpBinding: { identity: binding.identity, endpoint: binding.endpoint } }
}

/** @param value - untrusted IPC command. @returns bounded command with only the supported control fields. */
export function parseWebsiteHostCommand(value: unknown): DesktopWebsiteHostCommand {
  const candidate = record(value)
  if (candidate.action === 'sync') {
    if (!Array.isArray(candidate.profiles) || candidate.profiles.length > 64
      || Buffer.byteLength(JSON.stringify(candidate)) > 256 * 1024) throw new Error('Website pairing inventory exceeds its limit')
    const profiles = candidate.profiles.map(profile)
    if (new Set(profiles.map(pairing => pairing.id)).size !== profiles.length) throw new Error('Website pairing inventory has duplicate identities')
    return { action: 'sync', profiles }
  }
  if (typeof candidate.id !== 'string' || !UUID.test(candidate.id)) throw new Error('Invalid website request identity')
  const id = candidate.id as DesktopWebsiteRequestId
  if (candidate.action === 'revoke' || candidate.action === 'drain' || candidate.action === 'remove') return { action: candidate.action, id }
  if ((candidate.action === 'validate' || candidate.action === 'commit')
    && typeof candidate.epoch === 'number' && Number.isSafeInteger(candidate.epoch) && candidate.epoch > 0) {
    return { action: candidate.action, id, epoch: candidate.epoch }
  }
  throw new Error('Unsupported website control operation or generation')
}

/** @param request - exact controller-owned snapshot. @returns non-secret process response without live cancellation or owner objects. */
export function websiteHostSnapshot(request: WebsiteRequestSnapshot): DesktopWebsiteHostSnapshot {
  return { id: request.requestId, profile: request.profileId, sessionId: request.sessionId,
    epoch: request.epoch, status: request.status, ...(request.terminal === true ? { terminal: true } : {}) }
}

/**
 * @param current - current controller; undefined during boot or teardown.
 * @param send - narrow private IPC sender, never a remote/UI event publisher.
 * @returns synchronous packet admission; revoke runs before this function returns, while responses await settlement.
 */
export function installWebsiteControlReceiver(current: () => WebsiteRequestsController | undefined,
  send: (message: object) => Promise<void>): (message: unknown) => boolean {
  return (message) => {
    if (typeof message !== 'object' || message === null || !('type' in message) || message.type !== 'website-control') return false
    if (!('requestId' in message) || typeof message.requestId !== 'number'
      || !Number.isSafeInteger(message.requestId) || message.requestId <= 0) return true
    const requestId = message.requestId
    let operation: Promise<WebsiteRequestSnapshot | undefined>
    let admitted: WebsiteRequestsController | undefined
    let assertSettlement: (() => void) | undefined
    try {
      if (!('command' in message)) throw new Error('Missing website control command')
      const command = parseWebsiteHostCommand(message.command)
      const controller = admitted = current()
      if (controller === undefined) throw new Error('Website request Host is unavailable')
      let result: WebsiteRequestSnapshot | Promise<WebsiteRequestSnapshot> | Promise<void> | undefined
      switch (command.action) {
        case 'sync': controller.syncProfiles(command.profiles); break
        case 'validate': result = controller.validate(command.id, command.epoch); break
        case 'commit': result = controller.commit(command.id, command.epoch); break
        case 'revoke': result = controller.revoke(command.id); break
        case 'remove': result = controller.remove(command.id); break
        case 'drain':
          result = controller.drain(command.id)
          assertSettlement = () =>{  controller.assertDrained(command.id) }
          break
        default: assertNever(command)
      }
      operation = Promise.resolve(result).then((snapshot) => {
        if (current() !== controller) throw new Error('Website request Host changed during control')
        return snapshot === undefined ? undefined : snapshot
      })
    } catch (error) { operation = Promise.reject(error instanceof Error ? error : new Error(String(error))) }
    void operation.then((snapshot) => {
      if (current() !== admitted) throw new Error('Website request Host changed before response publication')
      if (snapshot !== undefined) {
        if (admitted === undefined) throw new Error('Website response has no admitted Host')
        admitted.assertCurrent(snapshot)
      }
      assertSettlement?.()
      return send({ type: 'website-control', requestId,
        ...(snapshot === undefined ? {} : { snapshot: websiteHostSnapshot(snapshot) }) })
    }).catch((error: unknown) => send({ type: 'website-control', requestId,
      error: (error instanceof Error ? error.message : String(error)).slice(0, 2048) }))
      .catch((error: unknown) => { console.error('Website control response delivery failed', error) })
    return true
  }
}
