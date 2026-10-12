/** Exact-path companion relay plugin; the managed HTTPS proxy supplies the public deployment authority. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { Config, validateConfig } from './config.ts'
import { Relay } from './relay.ts'

export { Config } from './config.ts'

/** Stable named function-plugin identity; this namespace has no default export. */
export const name = 'companion-relay'
/** The relay consumes only the HTTP upgrade registry. */
export const inject = ['webServer']

/**
 * Mount two exact routes and retain no application sessions, credentials, or offline work.
 * @param ctx - Context with the injected upgrade registry.
 * @param config - Explicit deployment identity and complete budgets.
 * @returns Resolves after effect-owned routes mount; registration failures dispose allocated resources.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  validateConfig(config)
  const relay = new Relay(config)
  const releases: (() => void)[] = []
  try {
    ctx.effect(() => {
      releases.push(ctx.webServer.registerUpgrade({
        path: '/companion/pc', handler: (req, socket, head) => { relay.upgrade('pc', req, socket, head) },
      }))
      releases.push(ctx.webServer.registerUpgrade({
        path: '/companion/phone', handler: (req, socket, head) => { relay.upgrade('phone', req, socket, head) },
      }))
      return async () => {
        for (const release of releases.reverse()) release()
        await relay.dispose()
      }
    }, 'companion-relay.routes-and-sockets')
  } catch (error) {
    for (const release of releases.reverse()) release()
    await relay.dispose()
    throw error
  }
}
