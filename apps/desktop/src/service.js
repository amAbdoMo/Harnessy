import { spawn } from 'node:child_process'

const READY_PREFIX = 'dsh web: '
const MAX_DIAGNOSTIC_LENGTH = 16_384

export function buildDshArguments(config) {
  return [
    config.nodeExecutable, config.dshEntry,
    '--profile', config.profile,
    '--host', '127.0.0.1',
    '--port', String(config.port),
    '--no-open',
  ]
}

export function extractReadyUrl(output, expectedPort) {
  for (const line of output.split(/\r?\n/u)) {
    if (!line.startsWith(READY_PREFIX)) continue
    let readyUrl
    try {
      readyUrl = new URL(line.slice(READY_PREFIX.length).trim())
    } catch {
      continue
    }
    if (readyUrl.protocol !== 'http:' || readyUrl.hostname !== '127.0.0.1') continue
    if (readyUrl.port !== String(expectedPort) || readyUrl.pathname !== '/') continue
    if (readyUrl.searchParams.getAll('token').length === 1) return readyUrl.href
  }
  return undefined
}

export function redactLaunchTokens(diagnosticText) {
  return diagnosticText.replace(/([?&]token=)[^&#\s]+/giu, '$1[redacted]')
}

export function classifyServiceFailure(error, output, port) {
  const detail = redactLaunchTokens(`${error instanceof Error ? error.message : String(error)}\n${output}`)
  if (/EADDRINUSE|address already in use/iu.test(detail)) {
    return `Custom Harness cannot start because local port ${String(port)} is already in use. Close the conflicting application, then retry.`
  }
  if (/client build record|client artifacts|ENOENT|cannot find|not found|404/iu.test(detail)) {
    return 'Custom Harness desktop assets are missing or do not match this build. Rebuild or reinstall the application, then retry.'
  }
  if (/timed out/iu.test(detail)) {
    return 'The Custom Harness service did not become ready in time. Retry, or inspect the product logs if the problem continues.'
  }
  const recentDetail = detail.trim().split(/\r?\n/u).slice(-8).join('\n')
  return recentDetail === ''
    ? 'The Custom Harness service stopped unexpectedly.'
    : `The Custom Harness service stopped unexpectedly.\n\n${recentDetail}`
}

async function assertCustomAssets(origin, config, fetchImplementation) {
  const manifestResponse = await fetchImplementation(new URL('/manifest.webmanifest', origin), {
    signal: AbortSignal.timeout(5_000),
  })
  const manifest = manifestResponse.ok ? await manifestResponse.json() : undefined
  const brandedManifest = manifest?.name === config.productName
    && Array.isArray(manifest.icons)
    && manifest.icons.some(icon => icon?.src === '/custom-harness.svg')
  if (!brandedManifest) throw new Error(`custom desktop asset check failed for manifest (${String(manifestResponse.status)})`)

  const iconResponse = await fetchImplementation(new URL('/custom-harness.svg', origin), {
    signal: AbortSignal.timeout(5_000),
  })
  if (!iconResponse.ok || !(await iconResponse.text()).includes('<svg')) {
    throw new Error(`custom desktop asset check failed for icon (${String(iconResponse.status)})`)
  }
}

class DshServiceSupervisor {
  constructor(config, dependencies) {
    this.config = config
    this.spawnProcess = dependencies.spawnProcess ?? spawn
    this.fetchImplementation = dependencies.fetchImplementation ?? globalThis.fetch
    this.setTimer = dependencies.setTimer ?? setTimeout
    this.clearTimer = dependencies.clearTimer ?? clearTimeout
    this.setRepeatingTimer = dependencies.setRepeatingTimer ?? setInterval
    this.clearRepeatingTimer = dependencies.clearRepeatingTimer ?? clearInterval
    this.onFailure = dependencies.onFailure ?? (() => {})
    this.onOutput = dependencies.onOutput ?? (() => {})
    this.output = ''
    this.stopping = false
    this.ready = false
    this.healthFailures = 0
  }

  async start() {
    this.spawnBackend()
    try {
      const launchUrl = await this.waitForReadiness()
      const origin = new URL(launchUrl).origin
      await assertCustomAssets(origin, this.config, this.fetchImplementation)
      this.ready = true
      this.startHealthMonitor(origin)
      return this.serviceHandle(launchUrl, origin)
    } catch (error) {
      this.stopImmediately()
      throw new Error(classifyServiceFailure(error, this.output, this.config.port), { cause: error })
    }
  }

  spawnBackend() {
    this.child = this.spawnProcess(this.config.jobLauncher, buildDshArguments(this.config), {
      cwd: this.config.workingDirectory,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    this.exited = new Promise(resolve => { this.resolveExit = resolve })
    this.child.stdout?.on('data', chunk => this.rememberOutput(chunk))
    this.child.stderr?.on('data', chunk => this.rememberOutput(chunk))
    this.child.once('exit', (code, signal) => this.backendExited(code, signal))
  }

  rememberOutput(chunk) {
    const output = String(chunk)
    this.output = `${this.output}${output}`.slice(-MAX_DIAGNOSTIC_LENGTH)
    this.onOutput(redactLaunchTokens(output))
  }

  backendExited(code, signal) {
    this.resolveExit({ code, signal })
    if (!this.ready || this.stopping) return
    this.clearRepeatingTimer(this.healthTimer)
    const failure = new Error(`backend exited (${String(code ?? signal)})`)
    this.onFailure(classifyServiceFailure(failure, this.output, this.config.port))
  }

  waitForReadiness() {
    return new Promise((resolve, reject) => {
      const settle = (callback, settlement) => {
        this.clearTimer(timeout)
        callback(settlement)
      }
      const inspectOutput = () => {
        const parsedUrl = extractReadyUrl(this.output, this.config.port)
        if (parsedUrl !== undefined) settle(resolve, parsedUrl)
      }
      const timeout = this.setTimer(() => {
        reject(new Error(`desktop backend readiness timed out after ${String(this.config.startupTimeoutMs)} ms`))
      }, this.config.startupTimeoutMs)
      this.child.stdout?.on('data', inspectOutput)
      this.child.once('error', error => settle(reject, error))
      this.child.once('exit', (code, signal) => {
        settle(reject, new Error(`desktop backend exited before readiness (${String(code ?? signal)})`))
      })
    })
  }

  startHealthMonitor(origin) {
    this.healthTimer = this.setRepeatingTimer(
      () => this.checkHealth(origin),
      this.config.healthIntervalMs,
    )
  }

  async checkHealth(origin) {
    if (this.stopping) return
    try {
      const response = await this.fetchImplementation(new URL('/manifest.webmanifest', origin), {
        signal: AbortSignal.timeout(5_000),
      })
      if (!response.ok) throw new Error(`health probe returned ${String(response.status)}`)
      this.healthFailures = 0
    } catch (error) {
      this.healthFailures += 1
      if (this.healthFailures < this.config.healthFailureLimit) return
      this.clearRepeatingTimer(this.healthTimer)
      this.onFailure(classifyServiceFailure(error, this.output, this.config.port))
    }
  }

  serviceHandle(launchUrl, origin) {
    return {
      launchUrl,
      origin,
      pid: this.child.pid,
      diagnosticOutput: () => redactLaunchTokens(this.output),
      stop: () => this.stop(),
    }
  }

  stopImmediately() {
    this.stopping = true
    this.clearRepeatingTimer(this.healthTimer)
    if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill()
  }

  async stop() {
    if (this.stopping) return this.exited
    this.stopImmediately()
    let timeout
    const boundedExit = new Promise(resolve => {
      timeout = this.setTimer(() => resolve({ code: null, signal: 'timeout' }), 5_000)
    })
    const exitStatus = await Promise.race([this.exited, boundedExit])
    this.clearTimer(timeout)
    return exitStatus
  }
}

export function startDshService(config, dependencies = {}) {
  return new DshServiceSupervisor(config, dependencies).start()
}
