/** Launch the Desktop profile through the Web application and report its URL to Electron. */

import { delimiter, join } from 'node:path'
import { inspect } from 'node:util'
import { loadLayeredEnv, loadProfileDirectory, reportSkippedBundles } from '@deepseek-ai/dsh-app-boot'
import { runProfile } from '@deepseek-ai/dsh/profile-boot'
import type {} from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-deepseek-account'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { installDesktopCompanionOwner } from '@deepseek-ai/dsh-companion-host'
import type { Config as CompanionConfig } from '@deepseek-ai/dsh-companion-host'
import { installDesktopCompanionControls, resolveDesktopCompanionConfig } from './companion.ts'
import * as desktopOffice from './office.ts'
import { localDragResource } from './file-drag.ts'
import { assertDesktopRemoteConnection, desktopWebArguments, resolveDesktopRemoteConnection } from './remote-connection.ts'

import { installDesktopUpdateTaskControl } from './update-tasks.ts'
import { installDesktopQuitInspection } from './quit-inspection.ts'
import { installPlatformSessionPublisher } from './platform-session.ts'
import { installOfficeEngineResolution } from './office-engine.ts'
import { installWebsiteMcpInspector } from './website-mcp.ts'
import { installWebsiteRequests } from './website-requests.ts'
import { installWebsiteControlReceiver, websiteHostSnapshot } from './website-control.ts'
import { installWebsiteParentChannel } from './website-parent.ts'
import { installDevicePreviewController } from './device-preview-controller.ts'
import { installDevicePreviewParentChannel } from './device-preview-parent.ts'
import { installDevicePreviewTools } from './device-preview-tools.ts'
import { installBrowserPreview } from './browser-preview.ts'

async function main(): Promise<void> {
  const remote = resolveDesktopRemoteConnection(process.env)
  const runtimeDir = process.argv[2] as string
  const projectDir = process.argv[3] as string
  installOfficeEngineResolution(runtimeDir)
  const installAnchor = join(runtimeDir, 'node_modules', '@deepseek-ai', 'dsh', 'package.json')
  const profile = loadProfileDirectory('dsh', projectDir, installAnchor)
  reportSkippedBundles('dsh', profile)
  let stopping: Promise<void> | undefined
  const companionLife = new AbortController()
  const control: {
    browserPreview?: ReturnType<typeof installBrowserPreview>
    companion?: ReturnType<typeof installDesktopCompanionControls>
    companionConfig?: CompanionConfig
    updateTasks?: ReturnType<typeof installDesktopUpdateTaskControl>
    quitInspection?: ReturnType<typeof installDesktopQuitInspection>
    websiteMcp?: ReturnType<typeof installWebsiteMcpInspector>
    websiteRequests?: ReturnType<typeof installWebsiteRequests>
    websiteParent?: ReturnType<typeof installWebsiteParentChannel>
    devicePreviewController?: ReturnType<typeof installDevicePreviewController>
    devicePreviewParent?: ReturnType<typeof installDevicePreviewParentChannel>
    devicePreviewTools?: ReturnType<typeof installDevicePreviewTools>
  } = {}
  const send = (message: object): Promise<void> => new Promise((resolve, reject) => {
    if (!process.connected || process.send === undefined) { reject(new Error('Desktop parent channel is unavailable')); return }
    process.send(message, (error) => { if (error === null) resolve(); else reject(error) })
  })
  const application = runProfile({
    environment: loadLayeredEnv('dsh'),
    profile: 'desktop',
    resolvedProfile: { profile, installAnchor },
    patchFiles: [],
    args: desktopWebArguments(remote),
    prepare(ctx) {
      control.browserPreview = installBrowserPreview(ctx, send)
      control.companionConfig = resolveDesktopCompanionConfig(process.env)
      installDesktopCompanionOwner(ctx, { home: resolveDshHome(), signal: companionLife.signal })
      control.companion = installDesktopCompanionControls(ctx, control.companionConfig, companionLife, send)
      control.websiteMcp = installWebsiteMcpInspector(ctx, projectDir)
      const parent = control.websiteParent = installWebsiteParentChannel(ctx, send)
      control.websiteRequests = installWebsiteRequests(ctx, control.websiteMcp, (request) => {
        if (!process.connected || process.send === undefined) throw new Error('Website request parent disconnected before revocation')
        return send({ type: 'website-revoked', snapshot: websiteHostSnapshot(request) })
      }, (request, signal) => parent.check(websiteHostSnapshot(request), signal),
      { mcpAuthorization: 'independent' })
      const previewController = control.devicePreviewController = installDevicePreviewController(ctx, send)
      const previewParent = control.devicePreviewParent = installDevicePreviewParentChannel(ctx, send)
      control.devicePreviewTools = installDevicePreviewTools(ctx, previewController, previewParent)
    },
    ...(process.argv[5] === undefined ? {} : {
      packageManager: {
        command: process.execPath,
        args: ['--expose-internals', process.argv[5]],
        env: {
          ELECTRON_RUN_AS_NODE: '1',
          DSH_DESKTOP_NODE_EXECUTABLE: process.execPath,
          PATH: `${process.argv[6] ?? ''}${delimiter}${process.env.PATH ?? ''}`,
        },
      },
    }),
  })
  const websiteControl = installWebsiteControlReceiver(
    () => stopping === undefined ? control.websiteRequests : undefined, send)
  const stop = (): Promise<void> => {
    companionLife.abort()
    return stopping ??= (async () => {
      control.devicePreviewParent?.close()
      // Startup failure is reported by main; shutdown only owns a tree that booted.
      const running = await application.catch(() => undefined)
      control.devicePreviewParent?.close()
      try { await control.devicePreviewController?.dispose() }
      finally { await running?.shutdown.shutdown(0) }
      if (process.connected) {
        await send({ type: 'shutdown-complete' })
        process.disconnect()
      }
    })()
  }
  process.on('message', (message: unknown) => {
    if (control.browserPreview?.receive(message) === true) return
    if (control.companion?.receive(message) === true) return
    if (control.devicePreviewController?.receive(message) === true || control.devicePreviewParent?.receive(message) === true) return
    if (typeof message !== 'object' || message === null || !('type' in message)) return
    if (message.type === 'shutdown') { void stop().catch((error: unknown) => { console.error(error) }); return }
    if (message.type === 'file-drag-resource') {
      if (!('requestId' in message) || !Number.isSafeInteger(message.requestId)
        || !('address' in message) || typeof message.address !== 'string') return
      const { requestId, address } = message
      void (async () => {
        try {
          if (stopping !== undefined) throw new Error('Host stopping')
          const { ctx } = await application
          companionLife.signal.throwIfAborted()
          await send({ type: 'file-drag-resource', requestId, resource: await localDragResource(ctx, address, companionLife.signal) })
        } catch (error) {
          console.error(error)
          await send({ type: 'file-drag-resource', requestId, resource: null, error: 'File drag resource unavailable' })
        }
      })().catch((error: unknown) => { console.error(error) })
      return
    }
    if (control.websiteParent?.receive(message) === true || websiteControl(message)) return
    if (message.type === 'website-mcp') {
      if (!('requestId' in message) || !Number.isSafeInteger(message.requestId)
        || !('serverName' in message) || typeof message.serverName !== 'string'
        || !/^[A-Za-z0-9_-]{1,32}$/.test(message.serverName)) return
      const { requestId, serverName } = message
      void (async () => {
        try {
          if (stopping !== undefined || control.websiteMcp === undefined) throw new Error('Website MCP registry is unavailable')
          await send({ type: 'website-mcp', requestId, binding: await control.websiteMcp(serverName) })
        } catch (error) {
          await send({ type: 'website-mcp', requestId, error: (error instanceof Error ? error.message : String(error)).slice(0, 2048) })
        }
      })().catch((error: unknown) => { console.error(error) })
      return
    }
    if (message.type === 'quit-inspection') {
      if (!('requestId' in message) || !Number.isSafeInteger(message.requestId)) return
      const requestId = message.requestId
      void (async () => {
        try {
          if (stopping !== undefined || control.quitInspection === undefined) throw new Error('desktop quit: Host is unavailable')
          const inspection = await control.quitInspection()
          await send({ type: 'quit-inspection', requestId, ...inspection })
        } catch (error) {
          // The shell treats an unknown state as interruptible work and asks before quitting.
          await send({ type: 'quit-inspection', requestId, activeTasks: true, scheduledTasks: false,
            error: error instanceof Error ? error.message : String(error) })
        }
      })().catch((error: unknown) => { console.error(error) })
      return
    }
    if (message.type !== 'update-tasks' || !('requestId' in message) || !Number.isSafeInteger(message.requestId)
      || !('action' in message) || !['inspect', 'lock', 'unlock'].includes(String(message.action))) return
    void (async () => {
      try {
        if (stopping !== undefined || control.updateTasks === undefined) throw new Error('desktop update: Host is unavailable')
        const active = await control.updateTasks(message.action as 'inspect' | 'lock' | 'unlock')
        await send({ type: 'update-tasks', requestId: message.requestId, active })
      } catch (error) {
        await send({ type: 'update-tasks', requestId: message.requestId, active: true,
          error: error instanceof Error ? error.message : String(error) })
      }
    })().catch((error: unknown) => { console.error(error) })
  })
  process.once('disconnect', () => {
    control.browserPreview?.close()
    control.websiteParent?.close()
    control.devicePreviewParent?.close()
    void stop().catch((error: unknown) => { console.error(error) })
  })
  const { ctx } = await application
  try {
    if (control.websiteRequests === undefined) throw new Error('Desktop website account services were not initialized')
    await ctx.loader.await()
    if (control.devicePreviewTools === undefined || control.devicePreviewController === undefined) {
      throw new Error('Desktop device preview tools were not initialized')
    }
    await control.devicePreviewTools.await()
    await control.devicePreviewController.await()
    if (control.companion === undefined) throw new Error('Desktop companion controls were not initialized')
    companionLife.signal.throwIfAborted()
    await control.companion.initialize()
  } catch (error) { await ctx.fiber.dispose(); throw error }
  control.updateTasks = installDesktopUpdateTaskControl(ctx)
  control.quitInspection = installDesktopQuitInspection(ctx)
  await ctx.plugin(desktopOffice, {
    runtimeDir,
    source: process.argv[4] ?? join(runtimeDir, '..', 'runtime', 'primary-runtime'),
    root: join(resolveDshHome(), 'dsh-runtimes', 'dsh-primary-runtime'),
  })
  installPlatformSessionPublisher(ctx, (session) => {
    if (process.connected) process.send?.({ type: 'platform-session', session })
  })
  if (remote !== undefined) {
    try { assertDesktopRemoteConnection(ctx, remote) }
    catch (error) { await ctx.fiber.dispose(); throw error }
  }
  if (stopping !== undefined) return
  const url = ctx.connection.authenticatedUrl(`http://127.0.0.1:${String(ctx.webServer.port)}`)
  if (process.connected) process.send?.({ type: 'ready', url,
    ...(remote === undefined ? {} : { remoteRoot: remote.remoteRoot }),
    injections: ctx.webServer.collectIndexInjections() }, (error) => { if (error !== null) console.error(error) })
}

/** Upper bound of the startup diagnostic carried over IPC; the head holds the message and stack. */
const MAX_FATAL_DIAGNOSTIC_CHARS = 64 * 1024

if (import.meta.main) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error)
    // The shell receives the complete inspected error here, not through stderr:
    // stderr bytes and this IPC message race, and the shell reports the first
    // failure it sees.
    const diagnostic = inspect(error, { depth: 4, maxArrayLength: 50 }).slice(0, MAX_FATAL_DIAGNOSTIC_CHARS)
    if (process.connected) process.send?.({ type: 'fatal', message, diagnostic }, (error) => { if (error !== null) console.error(error) })
    console.error(error)
    process.exitCode = 1
    if (process.connected) process.disconnect()
  })
}
