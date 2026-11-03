/** Apply Super Agent's Git and command settings to its own worker commands without changing the Host environment. */
import type { ShellExecSpec } from '@deepseek-ai/dsh-shell'

/** Build a shell invocation with removed ambient Git settings and explicit managed overrides. */
export function workerShellSpec(spec: ShellExecSpec, environment: Record<string, string | undefined>, platform: NodeJS.Platform): ShellExecSpec {
  const removed = Object.entries(environment).filter(([, value]) => value === undefined).map(([name]) => name)
  const cleared = platform === 'win32'
    ? removed.map(name => `Remove-Item -LiteralPath 'Env:${name}' -ErrorAction SilentlyContinue`).join('; ')
    : removed.length ? `unset ${removed.join(' ')}` : ''
  const variables = Object.fromEntries(Object.entries(environment).flatMap(([name, value]) => value === undefined ? [] : [[name, value]]))
  return { ...spec, command: cleared ? `${cleared}; ${spec.command}` : spec.command, env: { ...spec.env, ...variables } }
}
