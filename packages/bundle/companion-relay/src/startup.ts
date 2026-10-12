/** Profile-owned invocation grammar; help and usage rejection release no webserver rows. */
import { Command } from 'commander'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { parseCmdline } from '@deepseek-ai/dsh-cmdline'

/** Stable function-plugin identity. */
export const name = 'companion-relay-startup'
/** Launcher argument provider; the relay never consumes PC login tokens. */
export const inject = ['cmdlineArgs']

/** Supported profile identity rendered in help. */
export interface Config {
  profile: 'companion-relay'
}
/** Require the standalone profile identity without implicit startup values. */
export const Config: z<Config> = z.object({ profile: z.const('companion-relay').required() })

/** Accepted loopback bind values read by the webserver row. */
export interface CompanionRelayStartup {
  readonly host: '127.0.0.1'
  readonly port: number
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Present only after the relay profile's application grammar accepts the invocation. */
    companionRelayStartup: CompanionRelayStartup
  }
}

/**
 * Parse only supported relay bind flags; require explicit bind configuration in flags or environment.
 * @param ctx - Launcher-provided command line and bounded exit adapter.
 * @param config - Validated standalone profile identity.
 */
export function apply(ctx: Context, config: Config): void {
  const program = new Command()
    .name(`dsh --profile ${config.profile}`)
    .description('Serve live companion ciphertext behind a managed TLS reverse proxy.')
    .helpOption('-h, --help', 'show this help')
    .option('--host <host>', 'loopback bind host; otherwise DSH_COMPANION_RELAY_BIND_HOST is required')
    .option('--port <port>', 'bind port; otherwise DSH_COMPANION_RELAY_BIND_PORT is required')
  program.action(() => {
    const options = program.opts<{ host?: string; port?: string }>()
    const host = options.host ?? process.env.DSH_COMPANION_RELAY_BIND_HOST
    const portText = options.port ?? process.env.DSH_COMPANION_RELAY_BIND_PORT
    if (host !== '127.0.0.1') program.error('error: relay bind host must explicitly be 127.0.0.1; use a same-host managed TLS proxy')
    if (portText === undefined || !/^\d+$/.test(portText) || Number(portText) > 65535) {
      program.error('error: relay bind port must explicitly be an integer from 0 through 65535')
    }
    ctx.provide('companionRelayStartup', { host: '127.0.0.1', port: Number(portText) } satisfies CompanionRelayStartup)
  })
  parseCmdline(ctx, program)
}
