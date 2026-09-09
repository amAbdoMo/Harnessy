import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { test } from 'node:test'
import {
  buildDshArguments,
  classifyServiceFailure,
  extractReadyUrl,
  redactLaunchTokens,
  startDshService,
} from '../src/service.js'

const config = {
  nodeExecutable: 'C:\\node.exe',
  dshEntry: 'C:\\app\\bin.js',
  jobLauncher: 'C:\\app\\job.exe',
  workingDirectory: 'C:\\app',
  profile: 'custom-harness',
  productName: 'Custom Harness',
  port: 48_765,
  startupTimeoutMs: 100,
  healthIntervalMs: 10_000,
  healthFailureLimit: 3,
}

class FakeChild extends EventEmitter {
  constructor() {
    super()
    this.stdout = new PassThrough()
    this.stderr = new PassThrough()
    this.pid = 1234
    this.exitCode = null
    this.signalCode = null
    this.killed = false
  }

  kill() {
    this.killed = true
    this.signalCode = 'SIGTERM'
    queueMicrotask(() => this.emit('exit', null, 'SIGTERM'))
    return true
  }

  exit(code) {
    this.exitCode = code
    this.emit('exit', code, null)
  }
}

function customAssetFetch(input) {
  const url = new URL(input)
  if (url.pathname === '/manifest.webmanifest') {
    return Promise.resolve(new Response(JSON.stringify({
      name: 'Custom Harness',
      icons: [{ src: '/custom-harness.svg' }],
    }), { headers: { 'content-type': 'application/manifest+json' } }))
  }
  return Promise.resolve(new Response('<svg></svg>', { headers: { 'content-type': 'image/svg+xml' } }))
}

test('recognizes only authenticated readiness on the expected loopback port', () => {
  assert.equal(extractReadyUrl('dsh web: http://127.0.0.1:48765/?token=secret\n', 48_765), 'http://127.0.0.1:48765/?token=secret')
  assert.equal(extractReadyUrl('dsh web: http://192.168.1.2:48765/?token=secret\n', 48_765), undefined)
  assert.equal(extractReadyUrl('dsh web: http://127.0.0.1:48766/?token=secret\n', 48_765), undefined)
  assert.equal(extractReadyUrl('dsh web: http://127.0.0.1:48765/\n', 48_765), undefined)
})

test('redacts launch credentials and classifies actionable failures', () => {
  assert.equal(redactLaunchTokens('http://localhost/?token=very-secret&x=1'), 'http://localhost/?token=[redacted]&x=1')
  assert.match(classifyServiceFailure(new Error('EADDRINUSE'), '', 48_765), /48765.*already in use/u)
  assert.match(classifyServiceFailure(new Error('timed out'), '', 48_765), /did not become ready/u)
  assert.doesNotMatch(classifyServiceFailure(new Error('failed'), '?token=very-secret', 48_765), /very-secret/u)
})

test('builds one fixed-loopback custom-profile backend command', () => {
  assert.deepEqual(buildDshArguments(config), [
    'C:\\node.exe', 'C:\\app\\bin.js', '--profile', 'custom-harness',
    '--host', '127.0.0.1', '--port', '48765', '--no-open',
  ])
})

test('waits for readiness, verifies customized assets, and stops its Job owner', async () => {
  const child = new FakeChild()
  const servicePromise = startDshService(config, {
    spawnProcess(command, args) {
      assert.equal(command, config.jobLauncher)
      assert.deepEqual(args, buildDshArguments(config))
      return child
    },
    fetchImplementation: customAssetFetch,
  })
  child.stdout.write('booting\ndsh web: http://127.0.0.1:48765/?token=secret\n')
  const service = await servicePromise
  assert.equal(service.origin, 'http://127.0.0.1:48765')
  assert.doesNotMatch(service.diagnosticOutput(), /secret/u)
  await service.stop()
  assert.equal(child.killed, true)
})

test('uses the configured runtime root and redacts launch credentials from persisted output', async () => {
  const child = new FakeChild()
  const recorded = []
  const servicePromise = startDshService(config, {
    spawnProcess(command, args, options) {
      assert.equal(options.cwd, config.workingDirectory)
      return child
    },
    fetchImplementation: customAssetFetch,
    onOutput: output => recorded.push(output),
  })
  child.stdout.write('dsh web: http://127.0.0.1:48765/?token=secret\n')
  const service = await servicePromise
  assert.doesNotMatch(recorded.join(''), /secret/u)
  assert.match(recorded.join(''), /token=\[redacted\]/u)
  await service.stop()
})

test('kills a backend that does not reach readiness before the timeout', async () => {
  const child = new FakeChild()
  await assert.rejects(
    startDshService({ ...config, startupTimeoutMs: 5 }, { spawnProcess: () => child }),
    /did not become ready/u,
  )
  assert.equal(child.killed, true)
})

test('surfaces a backend that exits before readiness', async () => {
  const child = new FakeChild()
  const servicePromise = startDshService(config, { spawnProcess: () => child })
  child.exit(7)
  await assert.rejects(servicePromise, /exited before readiness \(7\)/u)
})

test('rejects a ready backend with missing or corrupt customized assets', async () => {
  const child = new FakeChild()
  const servicePromise = startDshService(config, {
    spawnProcess: () => child,
    fetchImplementation: () => Promise.resolve(new Response('missing', { status: 404 })),
  })
  child.stdout.write('dsh web: http://127.0.0.1:48765/?token=secret\n')
  await assert.rejects(servicePromise, /assets are missing/u)
  assert.equal(child.killed, true)
})

test('reports a sustained post-readiness health failure once', async () => {
  const child = new FakeChild()
  const failures = []
  let repeat
  let healthy = true
  const servicePromise = startDshService({ ...config, healthFailureLimit: 2 }, {
    spawnProcess: () => child,
    fetchImplementation(input) {
      if (healthy) return customAssetFetch(input)
      return Promise.reject(new Error('connection refused'))
    },
    setRepeatingTimer(callback) {
      repeat = callback
      return 1
    },
    clearRepeatingTimer: () => {},
    onFailure: message => failures.push(message),
  })
  child.stdout.write('dsh web: http://127.0.0.1:48765/?token=secret\n')
  const service = await servicePromise
  healthy = false
  await repeat()
  await repeat()
  assert.equal(failures.length, 1)
  assert.match(failures[0], /connection refused/u)
  await service.stop()
})

test('reports a backend crash after readiness', async () => {
  const child = new FakeChild()
  const failures = []
  const servicePromise = startDshService(config, {
    spawnProcess: () => child,
    fetchImplementation: customAssetFetch,
    onFailure: message => failures.push(message),
  })
  child.stdout.write('dsh web: http://127.0.0.1:48765/?token=secret\n')
  const service = await servicePromise
  child.exit(9)
  assert.equal(failures.length, 1)
  assert.match(failures[0], /backend exited \(9\)/u)
  await service.stop()
})
