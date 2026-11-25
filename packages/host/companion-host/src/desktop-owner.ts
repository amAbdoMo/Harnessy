/** Private boot-installed Desktop ownership, not a config flag or public RPC capability. */
import type { Context } from '@deepseek-ai/cordis'
import { mkdir, realpath } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { acquireHomeLock } from './home-lock.ts'
import type { BrowserShareHandler } from './types.ts'

/** Boot-installed Desktop capabilities used by the Host, never supplied by YAML or a renderer. */
export interface DesktopCompanionOwnerOptions {
  readonly home: string
  readonly signal: AbortSignal
  /** Optional native provider; the paired phone can observe or stop only a share started by Desktop. */
  readonly browserShare?: BrowserShareHandler
}
const owners = new WeakMap<Context, DesktopCompanionOwnerOptions>()

/**
 * Install once from Desktop Host's runProfile.prepare; the signal retires this Host incarnation.
 * @param ctx - Desktop application's root context, never a renderer-provided context.
 * @param owner - Actual local credential home and parent-disconnect/shutdown cancellation.
 * @returns Effect-owned registration disposer; does not start networking or acquire a lock.
 */
export function installDesktopCompanionOwner(ctx: Context, owner: DesktopCompanionOwnerOptions): () => Promise<void> {
  if (!isAbsolute(owner.home) || owners.has(ctx.root) || owner.signal.aborted) {
    throw new Error('companion-host: invalid or duplicate Desktop owner')
  }
  return ctx.effect(() => {
    owners.set(ctx.root, owner)
    return () => { if (owners.get(ctx.root) === owner) owners.delete(ctx.root) }
  }, 'companion-host.desktop-owner')
}

/**
 * Hold kernel exclusion on the canonical private home for the service lifetime.
 * @param ctx - Context with the boot-installed Desktop capability.
 * @returns Owner signal and awaited release; duplicate owners fail without stale-timer takeover.
 */
export async function acquireDesktopOwner(ctx: Context): Promise<{
  readonly signal: AbortSignal
  readonly browserShare?: BrowserShareHandler
  release(): Promise<void>
}> {
  const owner = owners.get(ctx.root)
  if (owner === undefined || owner.signal.aborted) throw new Error('companion-host: Desktop-owned Host required')
  await mkdir(owner.home, { recursive: true, mode: 0o700 })
  const home = await realpath(owner.home)
  const release = await acquireHomeLock(home)
  try { owner.signal.throwIfAborted() }
  catch (error) { await release(); throw error }
  return owner.browserShare === undefined
    ? { signal: owner.signal, release }
    : { signal: owner.signal, browserShare: owner.browserShare, release }
}
