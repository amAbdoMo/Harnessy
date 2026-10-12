/** Private boot-installed Desktop ownership, not a config flag or public RPC capability. */
import type { Context } from '@deepseek-ai/cordis'
import { mkdir, realpath } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { acquireHomeLock } from './home-lock.ts'

interface Owner {
  readonly home: string
  readonly signal: AbortSignal
}
const owners = new WeakMap<Context, Owner>()

/**
 * Install once from Desktop Host's runProfile.prepare; the signal retires this Host incarnation.
 * @param ctx - Desktop application's root context, never a renderer-provided context.
 * @param owner - Actual local credential home and parent-disconnect/shutdown cancellation.
 * @returns Effect-owned registration disposer; does not start networking or acquire a lock.
 */
export function installDesktopCompanionOwner(ctx: Context, owner: Owner): () => Promise<void> {
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
export async function acquireDesktopOwner(ctx: Context): Promise<{ readonly signal: AbortSignal; release(): Promise<void> }> {
  const owner = owners.get(ctx.root)
  if (owner === undefined || owner.signal.aborted) throw new Error('companion-host: Desktop-owned Host required')
  await mkdir(owner.home, { recursive: true, mode: 0o700 })
  const home = await realpath(owner.home)
  const release = await acquireHomeLock(home)
  try { owner.signal.throwIfAborted() }
  catch (error) { await release(); throw error }
  return { signal: owner.signal, release }
}
