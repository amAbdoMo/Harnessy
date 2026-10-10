/** Electron Node-mode child lifecycle for the shared Web application. */

import { spawn, type ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import type { PlatformSession } from '@deepseek-ai/dsh-deepseek-account'
import { desktopNodeEnvironment } from './node-environment.ts'
import type { DesktopWebsiteMcpBinding } from './website-profiles.ts'
import type {
  DesktopWebsiteHostCommand, DesktopWebsiteHostSnapshot, DesktopWebsiteOperationCommand, DesktopWebsitePageInfo,
  DesktopWebsiteBrowserOperation, DesktopWebsiteBrowserResult,
} from '@deepseek-ai/dsh-client-ui-sidebar-browser/types'
import { DesktopWebsiteOperations, isWebsiteOperationCommand } from './website-operations.ts'
import { DesktopDevicePreviewHost } from './device-preview-host.ts'
import type { DevicePreviewHostRequest, DevicePreviewId, DevicePreviewProjectId, DevicePreviewResponse } from '@deepseek-ai/dsh-client-ui-device-preview/types'

interface ReadyEvent {
  readonly type: 'ready'
  readonly url: string
  readonly injections?: readonly unknown[] | undefined
}

interface FatalEvent {
  readonly type: 'fatal'
  readonly message: string
  /** The Host's complete inspected error: stack, enumerable properties, cause chain. */
  readonly diagnostic?: string
}

interface PlatformSessionEvent {
  readonly type: 'platform-session'
  readonly session: PlatformSession | null
}

type DesktopHostEvent = DesktopWebsiteOperationCommand | ReadyEvent | FatalEvent | PlatformSessionEvent | { readonly type: 'shutdown-complete' } | {
  readonly type: 'update-tasks'
  readonly requestId: number
  readonly active: boolean
  readonly error?: string
} | {
  readonly type: 'quit-inspection'
  readonly requestId: number
  readonly activeTasks: boolean
  readonly scheduledTasks: boolean
  readonly error?: string
} | {
  readonly type: 'website-mcp'
  readonly requestId: number
  readonly binding?: DesktopWebsiteMcpBinding
  readonly error?: string
} | {
  readonly type: 'website-control'
  readonly requestId: number
  readonly snapshot?: DesktopWebsiteHostSnapshot
  readonly error?: string
} | {
  readonly type: 'website-revoked'
  readonly snapshot: DesktopWebsiteHostSnapshot
} | {
  readonly type: 'website-prepared'
  readonly snapshot: DesktopWebsiteHostSnapshot
} | {
  readonly type: 'website-check'
  readonly requestId: number
  readonly snapshot: DesktopWebsiteHostSnapshot
}

/** Correlated answer to one shell control request. */
type DesktopHostControlResponse = Exclude<Extract<DesktopHostEvent, { readonly requestId: number }>, { readonly type: 'website-check' }>

/** What quitting now would affect, as reported by the Host. */
export interface DesktopQuitInspection {
  readonly activeTasks: boolean
  readonly scheduledTasks: boolean
}

/** Quit inspection deadline; a slower Host counts as unknown work and the shell asks before quitting. */
export const QUIT_INSPECTION_DEADLINE_MS = 2_000

const MAX_HOST_DIAGNOSTIC_CHARS = 64 * 1024
const WEBSITE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

function isWebsiteSnapshot(value: unknown): value is DesktopWebsiteHostSnapshot {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const snapshot = value as Record<string, unknown>
  return typeof snapshot.id === 'string' && WEBSITE_UUID.test(snapshot.id)
    && typeof snapshot.profile === 'string' && WEBSITE_UUID.test(snapshot.profile)
    && typeof snapshot.sessionId === 'string' && snapshot.sessionId.length > 0 && snapshot.sessionId.length <= 4096
    && !/[\x00-\x1f\x7f]/.test(snapshot.sessionId)
    && typeof snapshot.epoch === 'number' && Number.isSafeInteger(snapshot.epoch) && snapshot.epoch > 0
    && ['pending', 'granted', 'revoked'].includes(String(snapshot.status))
    && (snapshot.terminal === undefined || (snapshot.terminal === true && snapshot.status === 'revoked'))
}

function isDesktopHostEvent(message: unknown): message is DesktopHostEvent {
  if (typeof message !== 'object' || message === null || !('type' in message)) return false
  const candidate = message as Record<string, unknown>
  switch (candidate.type) {
    case 'website-operation':
    case 'website-operation-cancel':
      return isWebsiteOperationCommand(message)
    case 'shutdown-complete':
      return true
    case 'ready':
      return typeof candidate.url === 'string'
    case 'platform-session': {
      const session = candidate.session
      if (session === null) return true
      if (typeof session !== 'object' || !('origin' in session) || !('token' in session)
        || typeof session.origin !== 'string' || typeof session.token !== 'string' || session.token.length === 0) return false
      if (!('userId' in session) || (session.userId !== null
        && (typeof session.userId !== 'string' || session.userId.length === 0))) return false
      if ('embeddedPageDist' in session && typeof session.embeddedPageDist !== 'string') return false
      if ('requestHeaders' in session && (typeof session.requestHeaders !== 'object' || session.requestHeaders === null
        || Array.isArray(session.requestHeaders)
        || Object.entries(session.requestHeaders).some(([name, value]) => typeof value !== 'string'
          || name !== name.toLowerCase() || /[\r\n]/.test(value)
          || ['authorization', 'x-dsh-auth-token', 'host', 'content-length', 'transfer-encoding', 'connection', 'content-type'].includes(name)))) return false
      try {
        const url = new URL(session.origin)
        return url.origin === session.origin && !url.username && !url.password
          && (url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))
      } catch { return false }
    }
    case 'fatal':
      return typeof candidate.message === 'string' && (candidate.diagnostic === undefined || typeof candidate.diagnostic === 'string')
    case 'update-tasks':
      return Number.isSafeInteger(candidate.requestId) && typeof candidate.active === 'boolean'
        && (candidate.error === undefined || typeof candidate.error === 'string')
    case 'website-mcp': {
      if (!Number.isSafeInteger(candidate.requestId)) return false
      if (typeof candidate.error === 'string') return candidate.error.length <= 2048 && candidate.binding === undefined
      const binding = candidate.binding
      return candidate.error === undefined && typeof binding === 'object' && binding !== null
        && 'identity' in binding && typeof binding.identity === 'string' && /^[0-9a-f]{64}$/.test(binding.identity)
        && 'endpoint' in binding && typeof binding.endpoint === 'string' && binding.endpoint.length > 0
        && binding.endpoint.length <= 2048 && !/[\x00-\x1f\x7f]/.test(binding.endpoint)
    }
    case 'website-check':
      return Number.isSafeInteger(candidate.requestId) && typeof candidate.requestId === 'number' && candidate.requestId > 0
        && isWebsiteSnapshot(candidate.snapshot) && candidate.snapshot.status === 'granted'
    case 'website-prepared':
      return isWebsiteSnapshot(candidate.snapshot) && candidate.snapshot.status === 'pending'
    case 'website-revoked':
      return isWebsiteSnapshot(candidate.snapshot) && candidate.snapshot.status === 'revoked'
    case 'website-control':
      return Number.isSafeInteger(candidate.requestId)
        && (candidate.error === undefined || (typeof candidate.error === 'string' && candidate.error.length <= 2048))
        && (candidate.snapshot === undefined || (candidate.error === undefined && isWebsiteSnapshot(candidate.snapshot)))
    case 'quit-inspection':
      return Number.isSafeInteger(candidate.requestId) && typeof candidate.activeTasks === 'boolean'
        && typeof candidate.scheduledTasks === 'boolean' && (candidate.error === undefined || typeof candidate.error === 'string')
    default:
      return false
  }
}

async function exitsWithin(exit: Promise<void>, milliseconds: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => { resolve(false) }, milliseconds)
    timer.unref()
  })
  try {
    return await Promise.race([exit.then(() => true), timeout])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/** Browser authentication URL reported by the running Web application. */
export interface DesktopHostReady {
  readonly url: string
  readonly injections?: readonly unknown[] | undefined
}

/** The child has exited, but task teardown did not finish successfully. */
export class DesktopHostUncleanExitError extends Error {}

/**
 * A Host failure reported over IPC before the process exited. `message` is what
 * the Host chose to show; `diagnostic` is its complete inspected error, kept
 * separately so a crash report can print it verbatim instead of a string escaped
 * inside another error's properties.
 */
export class DesktopHostFatalError extends Error {
  readonly #diagnostic: string | undefined

  /**
   * @param message - The Host's failure message.
   * @param diagnostic - The Host's inspected error, when the Host supplied one.
   */
  constructor(message: string, diagnostic: string | undefined) {
    super(message)
    this.#diagnostic = diagnostic
  }

  /** The Host's inspected error; a getter so `util.inspect` of this error does not repeat it as an escaped property. */
  get diagnostic(): string | undefined { return this.#diagnostic }
}

/** One Web backend running under the Electron executable in Node mode. */
export class DesktopHostProcess {
  private child: ChildProcess | undefined
  private readyResolve!: (ready: DesktopHostReady) => void
  private readyReject!: (error: Error) => void
  private readonly readyPromise = new Promise<DesktopHostReady>((resolve, reject) => {
    this.readyResolve = resolve
    this.readyReject = reject
  })
  private exitPromise: Promise<void> | undefined
  private stderr = ''
  private failureReported = false
  private stopping = false
  private shutdownCompleted = false
  private nextControlId = 1
  private readonly websiteRevocations = new Set<(snapshot: DesktopWebsiteHostSnapshot) => void>()
  private readonly websitePreparations = new Set<(snapshot: DesktopWebsiteHostSnapshot) => void>()
  private readonly websiteChecks = new Set<(snapshot: DesktopWebsiteHostSnapshot) => void>()
  private websitePageInfo: {
    readonly run: (snapshot: DesktopWebsiteHostSnapshot, signal: AbortSignal) => Promise<DesktopWebsitePageInfo>
    readonly check: (snapshot: DesktopWebsiteHostSnapshot) => void
    readonly browser?: (snapshot: DesktopWebsiteHostSnapshot, signal: AbortSignal,
      operation: DesktopWebsiteBrowserOperation) => Promise<DesktopWebsiteBrowserResult>
  } | undefined
  private websiteOperations: DesktopWebsiteOperations | undefined
  private readonly devicePreviews = new DesktopDevicePreviewHost(message => new Promise<void>((resolve, reject) => {
    const child = this.child
    if (child === undefined || !child.connected || this.stopping || this.failureReported) {
      reject(new Error('Device preview Host is unavailable')); return
    }
    child.send(message, (error) => { if (error === null) resolve(); else reject(error) })
  }))
  private readonly controlRequests = new Map<number, {
    type: DesktopHostControlResponse['type']
    resolve: (response: DesktopHostControlResponse) => void
    reject: (error: Error) => void
  }>()

  /**
   * @param node - Absolute Electron executable in Node mode.
   * @param runtimeDir - Immutable packages carried by the current application.
   * @param projectDir - Desktop plugin profile and child working directory.
   * @param inspectPort - Optional loopback inspector port for workspace development.
   * @param environment - Environment inherited by the Host and its plugin subprocesses.
   * @param onFailure - Receives the first unexpected child failure, including after readiness.
   * @param primaryRuntime - Optional bundled dependency payload; when supplied, missing sibling
   *   `office-skills` resources fail Host startup.
   * @param packageManager - Bundled pnpm entry and Node launcher directory, scoped to package operations.
   * @param onPlatformSession - Private credential updates for embedded Platform views; exceptions are logged
   *   without interrupting child teardown.
   */
  constructor(
    private readonly node: string,
    private readonly runtimeDir: string,
    private readonly projectDir: string,
    private readonly inspectPort?: number,
    private readonly environment: NodeJS.ProcessEnv = process.env,
    private readonly onFailure?: (error: Error) => void,
    private readonly primaryRuntime?: string,
    private readonly packageManager?: { readonly pnpm: string; readonly nodeBin: string },

    private readonly onPlatformSession?: (session: PlatformSession | null) => void,
  ) {}

  /**
   * Start this child once and await its Web application URL.
   * @returns Ready facts supplied by the child after application startup.
   */
  async start(): Promise<DesktopHostReady> {
    if (this.child !== undefined) return this.readyPromise
    const entry = join(this.runtimeDir, 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib', 'index.js')
    const child = spawn(this.node, [
      '--expose-internals',
      ...(this.inspectPort === undefined ? [] : [`--inspect=127.0.0.1:${String(this.inspectPort)}`]),
      entry,
      this.runtimeDir,
      this.projectDir,
      this.primaryRuntime ?? join(this.runtimeDir, '..', 'runtime', 'primary-runtime'),
      ...this.packageManager === undefined ? [] : [this.packageManager.pnpm, this.packageManager.nodeBin],
    ], {
      cwd: this.projectDir,
      env: desktopNodeEnvironment(this.node, undefined, this.environment),
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    })
    this.child = child
    const owner = this.websitePageInfo
    const assertOwner = () => {
      if (owner === undefined || this.websitePageInfo !== owner || this.child !== child || this.stopping) {
        throw new Error('Website native observation owner is unavailable')
      }
      return owner
    }
    const operations = new DesktopWebsiteOperations(
      (snapshot, signal) => assertOwner().run(snapshot, signal),
      (response) => {
        if (this.child !== child || !child.connected || (this.stopping && response.outcome === 'success')) return
        try { child.send(response, (error) => { if (error !== null && this.child === child) this.fail(error) }) }
        catch (error: unknown) { this.fail(error instanceof Error ? error : new Error('Website operation transport failed')) }
      },
      (snapshot) => { assertOwner().check(snapshot) },
      (snapshot, signal, operation) => {
        const browser = assertOwner().browser
        if (browser === undefined) throw new Error('Website browser operations are unavailable')
        return browser(snapshot, signal, operation)
      })
    this.websiteOperations = operations
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk: string) => { this.stderr = (this.stderr + chunk).slice(-MAX_HOST_DIAGNOSTIC_CHARS) })
    child.stdout?.pipe(process.stdout)
    child.on('message', (message: unknown) => {
      if (this.child !== child) return
      try {
        if (this.devicePreviews.receive(message, response => new Promise<void>((resolve, reject) => {
          if (this.child !== child || !child.connected || this.stopping) { reject(new Error('Device preview Host retired')); return }
          child.send(response, (error) => { if (error === null) resolve(); else reject(error) })
        }))) return
      } catch (error: unknown) {
        this.fail(error instanceof Error ? error : new Error('Device preview Host event rejected'))
        child.kill('SIGTERM')
        return
      }
      if (!isDesktopHostEvent(message)) {
        this.fail(new Error('dsh desktop host sent an invalid IPC event'))
        child.kill('SIGTERM')
        return
      }
      if (message.type === 'website-operation' || message.type === 'website-operation-cancel') operations.receive(message)
      else if (message.type === 'ready') this.readyResolve({ url: message.url, injections: message.injections })
      else if (message.type === 'platform-session') this.publishPlatformSession(message.session)
      else if (message.type === 'website-check') {
        let error: string | undefined
        try {
          if (this.websiteChecks.size !== 1) throw new Error('Website native admission owner is unavailable')
          for (const listener of this.websiteChecks) listener(message.snapshot)
        } catch (failure) { error = (failure instanceof Error ? failure.message : String(failure)).slice(0, 2048) }
        child.send({ type: 'website-check-result', requestId: message.requestId, accepted: error === undefined,
          ...(error === undefined ? {} : { error }) }, (failure) => { if (failure !== null) this.fail(failure) })
      }
      else if (message.type === 'website-prepared') {
        let error: string | undefined
        try {
          if (this.websitePreparations.size !== 1) throw new Error('Website native request owner is unavailable')
          for (const listener of this.websitePreparations) listener(message.snapshot)
        } catch (failure) { error = (failure instanceof Error ? failure.message : String(failure)).slice(0, 2048) }
        child.send({ type: 'website-prepared-ack', id: message.snapshot.id, ...(error === undefined ? {} : { error }) },
          (failure) => { if (failure !== null) this.fail(failure) })
      }
      else if (message.type === 'website-revoked') {
        for (const listener of this.websiteRevocations) {
          try { listener(message.snapshot) }
          catch (failure) { this.fail(failure instanceof Error ? failure : new Error(String(failure))) }
        }
      }
      else if (message.type === 'shutdown-complete') {
        if (this.stopping) this.shutdownCompleted = true
        else this.fail(new Error('dsh desktop host acknowledged an unrequested shutdown'))
      }
      else if (message.type === 'fatal') this.fail(new DesktopHostFatalError(message.message, message.diagnostic))
      else {
        const request = this.controlRequests.get(message.requestId)
        if (request !== undefined && request.type !== message.type) {
          request.reject(new Error('desktop Host answered with a different control response'))
        } else if (message.error === undefined) request?.resolve(message)
        else request?.reject(new Error(message.error))
      }
    })
    child.once('error', (error) => {
      void operations.close()
      if (this.child === child) this.fail(error)
    })
    child.once('disconnect', () => {
      void operations.close()
      if (this.child === child) {
        const suffix = this.stderr.trim() === '' ? '' : `: ${this.stderr.trim()}`
        this.fail(new Error(`dsh desktop host disconnected${suffix}`))
      }
    })
    this.exitPromise = new Promise<void>((resolve) => {
      child.once('close', (code) => {
        void operations.close()
        if (this.child === child) {
          const suffix = this.stderr.trim() === '' ? '' : `: ${this.stderr.trim()}`
          if (code !== 0 && code !== null) this.fail(new Error(`dsh desktop host exited with ${String(code)}${suffix}`))
          else this.fail(new Error(`dsh desktop host stopped${suffix}`))
        }
        resolve()
      })
    })
    return this.readyPromise
  }

  /**
   * Inspect active work or lock request admission for update handoff.
   * @param action - Read-only inspection, admission lock, or recovery unlock.
   * @returns Whether live tasks would be affected. Locking drains admitted API requests before inspecting tasks;
   * an unanswered drain fails at the control-request deadline without authorizing installation.
   */
  async updateTasks(action: 'inspect' | 'lock' | 'unlock'): Promise<boolean> {
    const response = await this.control({ type: 'update-tasks', action }, 10_000, 'desktop update: task inspection timed out')
    if (response.type !== 'update-tasks') throw new Error('desktop update: Host answered with a different control response')
    return response.active
  }

  /**
   * Ask the Host what quitting now would interrupt.
   * @returns Active tasks and armed scheduled reminders; rejects when the Host is unavailable or misses
   * {@link QUIT_INSPECTION_DEADLINE_MS}, and the shell then asks before quitting.
   */
  async inspectQuit(): Promise<DesktopQuitInspection> {
    const response = await this.control({ type: 'quit-inspection' }, QUIT_INSPECTION_DEADLINE_MS, 'desktop quit: inspection timed out')
    if (response.type !== 'quit-inspection') throw new Error('desktop quit: Host answered with a different control response')
    return { activeTasks: response.activeTasks, scheduledTasks: response.scheduledTasks }
  }

  /** @param serverName - human-selected configured namespace. @returns the current non-secret endpoint binding. */
  async inspectWebsiteMcp(serverName: string): Promise<DesktopWebsiteMcpBinding> {
    const response = await this.control({ type: 'website-mcp', serverName }, 10_000, 'Website MCP registry inspection timed out')
    if (response.type !== 'website-mcp' || response.binding === undefined) throw new Error('Website MCP registry returned no endpoint binding')
    return response.binding
  }

  /**
   * Install the sole native observation owner before child startup.
   * @param listener - observe through captured native authority; resolve only after physical settlement.
   * @param check - synchronously recheck authority immediately before publishing success.
   * @param browser - optional captured same-guest browser executor; absence fails closed.
   * @returns disposer that stops admission/success before aborting, then awaits settlement and rejection replies to the captured child.
   */
  onWebsitePageInfo(listener: (snapshot: DesktopWebsiteHostSnapshot, signal: AbortSignal) => Promise<DesktopWebsitePageInfo>,
    check: (snapshot: DesktopWebsiteHostSnapshot) => void,
    browser?: (snapshot: DesktopWebsiteHostSnapshot, signal: AbortSignal,
      operation: DesktopWebsiteBrowserOperation) => Promise<DesktopWebsiteBrowserResult>): () => Promise<void> {
    if (this.websitePageInfo !== undefined) throw new Error('Website native observation owner is already registered')
    if (this.child !== undefined) throw new Error('Website native observation owner must register before child startup')
    const owner = { run: listener, check, ...browser === undefined ? {} : { browser } }
    this.websitePageInfo = owner
    let disposal: Promise<void> | undefined
    return () => {
      if (disposal !== undefined) return disposal
      const settlement: PromiseWithResolvers<void> = Promise.withResolvers()
      disposal = settlement.promise
      this.websitePageInfo = undefined
      const quiescence = this.websiteOperations?.close() ?? Promise.resolve()
      void quiescence.then(settlement.resolve, settlement.reject)
      return disposal
    }
  }

  /**
   * @param listener - synchronously validate the exact current native grant before a Host operation; throwing refuses admission.
   * @returns listener disposer.
   */
  onWebsiteCheck(listener: (snapshot: DesktopWebsiteHostSnapshot) => void): () => void {
    this.websiteChecks.add(listener)
    return () => { this.websiteChecks.delete(listener) }
  }

  /**
   * @param listener - capture one exact pending Host request before its UI handoff; throwing refuses acknowledgement.
   * @returns listener disposer.
   */
  onWebsitePrepared(listener: (snapshot: DesktopWebsiteHostSnapshot) => void): () => void {
    this.websitePreparations.add(listener)
    return () => { this.websitePreparations.delete(listener) }
  }

  /** @param listener - synchronous native authority revocation from this exact captured Host. @returns listener disposer. */
  onWebsiteRevoked(listener: (snapshot: DesktopWebsiteHostSnapshot) => void): () => void {
    this.websiteRevocations.add(listener)
    return () => { this.websiteRevocations.delete(listener) }
  }

  /**
   * @param command - private inventory, exact-generation validation/admission, or teardown.
   * @returns matching request snapshot, when supplied.
   */
  async websiteControl(command: DesktopWebsiteHostCommand): Promise<DesktopWebsiteHostSnapshot | undefined> {
    const response = await this.control({ type: 'website-control', command }, 10_000, 'Website request control timed out')
    if (response.type !== 'website-control') throw new Error('Website Host answered with a different control response')
    if (command.action === 'sync' || command.action === 'drain' || command.action === 'remove') {
      if (response.snapshot !== undefined) throw new Error('Website Host returned an unexpected request snapshot')
      return undefined
    }
    const snapshot = response.snapshot
    if (snapshot === undefined || snapshot.id !== command.id
      || (command.action !== 'revoke' && snapshot.epoch !== command.epoch)
      || snapshot.status !== (command.action === 'commit' ? 'granted' : command.action === 'validate' ? 'pending' : 'revoked')) {
      throw new Error('Website Host answered for a different request or generation')
    }
    return snapshot
  }

  /** @param listener - sole same-preview native handler installed before startup. @returns registration disposer. */
  onDevicePreviewRequest(listener: (request: DevicePreviewHostRequest) => Promise<DevicePreviewResponse | undefined>): () => void {
    if (this.child !== undefined) throw new Error('Device preview native owner must register before Host startup')
    return this.devicePreviews.register(listener)
  }

  /** @param projectId - owned launcher from the displayed preview. @returns after its process range settles. */
  stopDevicePreview(projectId: DevicePreviewProjectId): Promise<void> { return this.devicePreviews.stop(projectId) }

  /** @param previewId - occurrence whose Main authority was retired; launchers remain owned until explicit Stop. */
  retireDevicePreview(previewId: DevicePreviewId): void {
    void this.devicePreviews.retire(previewId).catch((error: unknown) => { console.error('Device preview retirement could not be delivered', error) })
  }

  private async control(
    request: { readonly type: 'update-tasks'; readonly action: 'inspect' | 'lock' | 'unlock' } | { readonly type: 'quit-inspection' }
      | { readonly type: 'website-mcp'; readonly serverName: string }
      | { readonly type: 'website-control'; readonly command: DesktopWebsiteHostCommand },
    deadlineMs: number, deadlineMessage: string,
  ): Promise<DesktopHostControlResponse> {
    const child = this.child
    if (child === undefined || !child.connected || this.failureReported || this.stopping) {
      const operation = request.type === 'website-mcp' ? 'Website MCP registry'
        : request.type === 'website-control' ? 'Website request' : request.type === 'update-tasks' ? 'desktop update' : 'desktop quit'
      throw new Error(`${operation}: Host is unavailable`)
    }
    const requestId = this.nextControlId++
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await new Promise<DesktopHostControlResponse>((resolve, reject) => {
        this.controlRequests.set(requestId, { type: request.type, resolve, reject })
        timer = setTimeout(() => { reject(new Error(deadlineMessage)) }, deadlineMs)
        child.send({ ...request, requestId }, (error) => { if (error !== null) reject(error) })
      })
    } finally {
      clearTimeout(timer)
      this.controlRequests.delete(requestId)
    }
  }

  /**
   * Request teardown and await child exit, escalating termination when needed.
   * @param requireGraceful - Reject update handoff after forced termination or unsuccessful child exit.
   * @returns Completion of owned process teardown and physical native-operation settlement.
   * DesktopHostUncleanExitError confirms exit but refuses installation;
   * other failures do not confirm exit.
   */
  async stop(requireGraceful = false): Promise<void> {
    const child = this.child
    if (child === undefined) return
    this.stopping = true
    this.devicePreviews.close(new Error('Device preview Host is stopping'))
    const operationsSettled = this.websiteOperations?.close() ?? Promise.resolve()
    this.publishPlatformSession(null)
    let graceful = false
    try {
      if (child.connected) {
        try { child.send({ type: 'shutdown' }, (error) => { if (error !== null && this.child === child) this.fail(error) }) }
        catch (error: unknown) { this.fail(error instanceof Error ? error : new Error('Desktop shutdown transport failed')) }
      }
      const exited = this.exitPromise ?? Promise.resolve()
      graceful = await exitsWithin(exited, 10_000)
      if (!graceful) child.kill('SIGTERM')
      if (!await exitsWithin(exited, 5_000)) {
        child.kill('SIGKILL')
        if (!await exitsWithin(exited, 5_000)) {
          throw new Error('dsh desktop host did not exit after SIGKILL')
        }
      }
    } finally {
      await operationsSettled
    }
    if (this.child === child) this.child = undefined
    if (requireGraceful && (!graceful || child.exitCode !== 0 || !this.shutdownCompleted)) {
      // This diagnostic reaches expandable UI; arbitrary plugin stderr can contain credentials.
      throw new DesktopHostUncleanExitError(`desktop update: Host did not complete graceful task teardown (exit ${String(child.exitCode)}, signal ${String(child.signalCode)}, shutdown acknowledged ${String(this.shutdownCompleted)}, graceful deadline exceeded ${String(!graceful)})`)
    }
  }

  private publishPlatformSession(session: PlatformSession | null): void {
    try { this.onPlatformSession?.(session) }
    catch (error: unknown) { console.error('desktop host platform session listener failed', error) }
  }

  private fail(error: Error): void {
    this.devicePreviews.close(error)
    void this.websiteOperations?.close()
    this.publishPlatformSession(null)
    this.readyReject(error)
    for (const request of this.controlRequests.values()) request.reject(error)
    this.controlRequests.clear()
    if (!this.failureReported && !this.stopping) {
      this.failureReported = true
      try { this.onFailure?.(error) } catch (listenerError) {
        console.error('desktop host failure listener failed', listenerError)
      }
    }
  }
}
