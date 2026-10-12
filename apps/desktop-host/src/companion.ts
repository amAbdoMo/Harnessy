/** Desktop-only companion configuration and closed private Main control; never an operator endpoint. */
import type { Context } from '@deepseek-ai/cordis'
import CompanionHost from '@deepseek-ai/dsh-companion-host'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import type { Config } from '@deepseek-ai/dsh-companion-host'
import type { CompanionControlCommand, CompanionControlResult } from '@deepseek-ai/dsh-companion-host/types'
import { parseCompanionControlCommand } from '@deepseek-ai/dsh-companion-host/desktop-control'

const MAX_CONTROL_REQUEST_BYTES = 8192
const MAX_CONTROL_RESPONSE_BYTES = 65536
const MAX_PENDING_CONTROLS = 16

/**
 * Read release/operator configuration without inventing a hosted origin or endpoint budgets.
 * @param environment - Desktop Host launch environment; no values are rendered or logged.
 * @returns Disabled configuration, or schema-validated explicit deployment data.
 */
export function resolveDesktopCompanionConfig(environment: NodeJS.ProcessEnv): Config {
  const httpsOrigin = environment.DSH_DESKTOP_COMPANION_HTTPS_ORIGIN
  const raw = environment.DSH_DESKTOP_COMPANION_BUDGETS
  if (httpsOrigin === undefined && raw === undefined) return {}
  if (httpsOrigin === undefined || raw === undefined || Buffer.byteLength(raw, 'utf8') > MAX_CONTROL_REQUEST_BYTES) {
    throw new Error('Desktop companion requires an actual HTTPS origin and complete bounded budgets')
  }
  let budgets: unknown
  try { budgets = JSON.parse(raw) }
  catch (_error) { throw new Error('Desktop companion budgets must be valid JSON') }
  // The callable schema validates unknown input; its source generic otherwise requires an already-decoded Config.
  const parse = CompanionHost.Config as (input: unknown) => Config
  return parse({ httpsOrigin, budgets })
}

/** Private receiver retained only by the owned Desktop Host parent channel. */
export interface DesktopCompanionControls {
  /**
   * Consume only correlated companion-control messages from this process's parent pipe.
   * @param message - Decoded private IPC object, never Web/Gateway input.
   * @returns Whether this receiver owns the message type.
   */
  receive(message: unknown): boolean
}

async function execute(host: CompanionHost, command: CompanionControlCommand): Promise<CompanionControlResult> {
  switch (command.kind) {
    case 'describe': return { kind: 'status', status: host.describe() }
    case 'createInvitation': return { kind: 'invitation', invitation: await host.createInvitation() }
    case 'approveCandidate':
      await host.approveCandidate(command.candidateId, command.fingerprint)
      return { kind: 'completed' }
    case 'cancelInvitation':
      await host.cancelInvitation()
      return { kind: 'completed' }
    case 'revokeGrant':
      await host.revokeGrant(command.grantId)
      return { kind: 'completed' }
    default: return assertNever(command)
  }
}

/**
 * Bind native management to the boot-owned context and parent lifetime, not to a phone or renderer.
 * @param ctx - Desktop Host application context; the optional service is read through ctx.get.
 * @param signal - Synchronously aborted on Main disconnect or Host shutdown.
 * @param send - Private child-to-Main IPC writer; invitation results must remain Main-only.
 * @returns Bounded receiver; late operations cannot publish after parent retirement.
 */
export function installDesktopCompanionControls(ctx: Context, signal: AbortSignal,
  send: (message: object) => Promise<void>): DesktopCompanionControls {
  let pending = 0
  return {
    receive(message) {
      if (typeof message !== 'object' || message === null || !('type' in message) || message.type !== 'companion-control') return false
      if (!('requestId' in message) || typeof message.requestId !== 'number'
        || !Number.isSafeInteger(message.requestId) || message.requestId < 1) return true
      const requestId = message.requestId
      if (signal.aborted) return true
      // Saturation drops the request without allocating another response; Main's deadline reports it.
      if (pending >= MAX_PENDING_CONTROLS) return true
      pending++
      void (async () => {
        try {
          const text = JSON.stringify(message)
          if (Buffer.byteLength(text, 'utf8') > MAX_CONTROL_REQUEST_BYTES || !('command' in message)) {
            throw new Error('Invalid companion control message')
          }
          const command = parseCompanionControlCommand(message.command)
          signal.throwIfAborted()
          const host = ctx.get('companionHost')
          if (host === undefined) throw new Error('Companion service unavailable')
          const result = await execute(host, command)
          signal.throwIfAborted()
          const response = { type: 'companion-control', requestId, result }
          if (Buffer.byteLength(JSON.stringify(response), 'utf8') > MAX_CONTROL_RESPONSE_BYTES) throw new Error('Companion response limit')
          await send(response)
        } catch (_error) {
          if (!signal.aborted) await send({ type: 'companion-control', requestId, error: 'unavailable' })
        } finally { pending-- }
      })().catch((_error: unknown) => {
        // A disconnected private pipe cannot deliver a result; the owned Host teardown withdraws authority.
      })
      return true
    },
  }
}
