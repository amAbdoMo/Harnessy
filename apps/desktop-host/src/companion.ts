/** Desktop-only companion configuration and closed private Main control; never an operator endpoint. */
import type { Context } from '@deepseek-ai/cordis'
import { readFileSync } from 'node:fs'
import CompanionHost, { resolveConfig } from '@deepseek-ai/dsh-companion-host'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import type { Config } from '@deepseek-ai/dsh-companion-host'
import type { CompanionControlCommand, CompanionControlResult } from '@deepseek-ai/dsh-companion-host/types'
import { parseCompanionControlCommand } from '@deepseek-ai/dsh-companion-host/desktop-control'
import { DesktopCompanionActivation } from './companion-activation.ts'

const MAX_CONTROL_REQUEST_BYTES = 8192
const MAX_CONTROL_RESPONSE_BYTES = 65536
const MAX_PENDING_CONTROLS = 16

/**
 * Select the app-owned public deployment or a complete operator override; never combine them.
 * @param environment - Desktop Host launch environment; no values are rendered or logged.
 * @returns Schema-validated explicit deployment data; missing/malformed assets and partial overrides throw.
 */
export function resolveDesktopCompanionConfig(environment: NodeJS.ProcessEnv): Config {
  const httpsOrigin = environment.DSH_DESKTOP_COMPANION_HTTPS_ORIGIN
  const raw = environment.DSH_DESKTOP_COMPANION_BUDGETS
  // The callable schema consumes JSON; its TypeScript generic otherwise requires an already-decoded Config.
  const parse = CompanionHost.Config as (input: unknown) => Config
  if (httpsOrigin === undefined && raw === undefined) {
    const rawDeployment = readFileSync(new URL('../companion-deployment.json', import.meta.url), 'utf8')
    if (Buffer.byteLength(rawDeployment, 'utf8') > 8192) throw new Error('Desktop companion deployment exceeds its byte limit')
    const deployment: unknown = JSON.parse(rawDeployment)
    if (typeof deployment !== 'object' || deployment === null || Array.isArray(deployment) ||
      Object.keys(deployment).some(key => key !== 'httpsOrigin' && key !== 'budgets')) {
      throw new Error('Desktop companion deployment has invalid fields')
    }
    const config = parse(deployment)
    resolveConfig(config)
    return config
  }
  if (httpsOrigin === undefined || raw === undefined || Buffer.byteLength(raw, 'utf8') > MAX_CONTROL_REQUEST_BYTES) {
    throw new Error('Desktop companion requires an actual HTTPS origin and complete bounded budgets')
  }
  let budgets: unknown
  try { budgets = JSON.parse(raw) }
  catch (_error) { throw new Error('Desktop companion budgets must be valid JSON') }
  const config = parse({ httpsOrigin, budgets })
  resolveConfig(config)
  return config
}

/** Private receiver retained only by the owned Desktop Host parent channel. */
export interface DesktopCompanionControls {
  /** Restore committed local consent after profile services are ready, without prompting or granting phone authority. */
  initialize(): Promise<void>
  /**
   * Consume only correlated companion-control messages from this process's parent pipe.
   * @param message - Decoded private IPC object, never Web/Gateway input.
   * @returns Whether this receiver owns the message type.
   */
  receive(message: unknown): boolean
}

async function execute(host: CompanionHost,
  command: Exclude<CompanionControlCommand, { readonly kind: 'describe' | 'activate' }>): Promise<CompanionControlResult> {
  switch (command.kind) {
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
    case 'setSessionManagement':
      await host.setSessionManagement(command)
      return { kind: 'completed' }
    default: return assertNever(command)
  }
}

/**
 * Bind native management to the boot-owned context and parent lifetime, not to a phone or renderer.
 * @param ctx - Desktop Host application context; the optional service is read through ctx.get.
 * @param config - Validated app-owned deployment, or complete operator override; consent still gates mounting.
 * @param life - Companion-only owner lifetime, aborted on Main loss, shutdown or consent withdrawal.
 * @param send - Private child-to-Main IPC writer; invitation results must remain Main-only.
 * @returns Bounded receiver; late operations cannot publish after parent retirement.
 */
export function installDesktopCompanionControls(ctx: Context, config: Config, life: AbortController,
  send: (message: object) => Promise<void>): DesktopCompanionControls {
  const signal = life.signal
  const activation = new DesktopCompanionActivation(ctx, config, life)
  let pending = 0
  return {
    initialize: () => activation.initialize(),
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
          let result: CompanionControlResult
          if (command.kind === 'describe') result = activation.describe()
          else if (command.kind === 'activate') {
            await activation.activate()
            result = { kind: 'completed' }
          } else {
            const host = ctx.get('companionHost')
            if (host === undefined) throw new Error('Companion service unavailable')
            result = await execute(host, command)
          }
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
