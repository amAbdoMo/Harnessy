/** Opt-in private HTTPS advertisement over the existing loopback Desktop Host. */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-host-webserver'

/** User-owned private Serve entry and fixed loopback target; contains no credential. */
export interface DesktopRemoteConnection {
  readonly remoteRoot: string
  readonly hostname: string
  readonly listenPort: number
}

/**
 * Resolve the paired environment opt-in before starting the Web application.
 * @param environment - Desktop launch environment; both settings must be absent or present.
 * @returns Canonical private HTTPS root and fixed port, or undefined for dynamic local-only startup.
 */
export function resolveDesktopRemoteConnection(environment: NodeJS.ProcessEnv): DesktopRemoteConnection | undefined {
  const root = environment.DSH_DESKTOP_REMOTE_URL
  const port = environment.DSH_DESKTOP_LISTEN_PORT
  if (root === undefined && port === undefined) return undefined
  if (root === undefined || port === undefined) {
    throw new Error('Desktop phone connection requires both DSH_DESKTOP_REMOTE_URL and DSH_DESKTOP_LISTEN_PORT')
  }
  // Match the raw input before URL normalization can erase credentials, paths or whitespace.
  const match = /^https:\/\/([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.ts\.net)(?::443)?\/?$/i.exec(root)
  if (match?.[1] === undefined || /\s/.test(root)) {
    throw new Error('DSH_DESKTOP_REMOTE_URL must be a credential-free HTTPS machine.tailnet.ts.net root on port 443')
  }
  if (port.length === 0 || /\D/.test(port) || !Number.isSafeInteger(Number(port)) || Number(port) < 1 || Number(port) > 65535) {
    throw new Error('DSH_DESKTOP_LISTEN_PORT must be an integer from 1 through 65535')
  }
  const url = new URL(root)
  return { remoteRoot: url.href, hostname: url.hostname, listenPort: Number(port) }
}

/**
 * Select invocation flags without changing Web authentication or exposing another listener.
 * @param remote - Validated opt-in; absent retains the OS-assigned port.
 * @returns Arguments for the existing Desktop profile runner.
 */
export function desktopWebArguments(remote: DesktopRemoteConnection | undefined): string[] {
  return ['--no-open', '--no-print-url', ...(remote === undefined ? ['--port', '0'] : [
    '--host', '127.0.0.1', '--port', String(remote.listenPort),
    '--public-url', remote.remoteRoot, '--trusted-host', remote.hostname,
  ])]
}

/**
 * Refuse readiness if profile overrides changed the fixed listener or excluded the remote authority.
 * @param ctx - Settled Web application context.
 * @param remote - Validated private Serve opt-in.
 */
export function assertDesktopRemoteConnection(ctx: Context, remote: DesktopRemoteConnection): void {
  if (ctx.webServer.host !== '127.0.0.1' || ctx.webServer.port !== remote.listenPort) {
    throw new Error('Desktop phone connection requires its configured fixed loopback listener')
  }
  // A hostname trustedHosts entry accepts any port; this does not narrow existing API trust semantics.
  // Missing credentials must reach authentication (401), never an authorization bypass.
  if (ctx.connection.requestRejection({ headers: {
    host: remote.hostname, origin: remote.remoteRoot.slice(0, -1), 'sec-fetch-site': 'same-origin',
  } }) !== 401) {
    throw new Error('Desktop phone connection requires its remote authority to pass Host/Origin checks and require authentication')
  }
}
