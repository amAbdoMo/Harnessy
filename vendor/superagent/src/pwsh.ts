/** PowerShell provider for Super Agent's managed presets, with per-command Git and CLI settings. */
import { SandboxPwshExecutor } from '@deepseek-ai/dsh-pwsh-sandbox'
import type { ShellExecSpec, ShellExecution } from '@deepseek-ai/dsh-shell'
import type {} from './app/runtime.ts'
import { workerShellSpec } from './worker-shell.ts'

/** Keeps Super Agent's worker environment out of ordinary Harnessy commands. */
export default class SuperagentPwsh extends SandboxPwshExecutor {
  static override inject = [...SandboxPwshExecutor.inject, 'orchestrator']

  override execute(spec: ShellExecSpec): Promise<ShellExecution> {
    return super.execute(workerShellSpec(spec, this.ctx.orchestrator.workerEnvironment, 'win32'))
  }
}
