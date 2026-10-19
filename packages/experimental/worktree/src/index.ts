/** Creates a new Git branch and checkout, then changes the calling Session's working directory. */

import { randomUUID } from 'node:crypto'
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-fs'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import type {} from '@deepseek-ai/dsh-working-directory'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import { WORKTREE_CHILD, parseAllocation, parseInspection } from './child.ts'
import type { CheckoutInspection, DirectoryIdentity } from './child.ts'
import { NODE_PRELOAD_ENV, runCommand } from './process.ts'
import type { ProcessConfig } from './process.ts'
import type { CreatedWorktree, CreateWorktreeRequest } from './types.ts'

export type { CreatedWorktree, CreateWorktreeRequest } from './types.ts'

/** Worktree location, generated names, executables, and subprocess resource limits. */
export interface Config extends ProcessConfig {
  /** Relative checkout pool inside the source repository. */
  directory: string
  /** Prefix for automatically generated branch and checkout names. */
  namePrefix: string
  /** Git 2.45 or newer executable name or absolute execution-world path. */
  gitCommand: string
  /** Node executable used for sandboxed directory allocation and checkout inspection. */
  nodeCommand: string
}

interface WorktreeSpec {
  branch: string
  revision: string
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    worktrees: WorktreeService
  }
}

/** Reject path traversal independently of Git's branch-name grammar. */
function relativePath(value: string): boolean {
  return value.length > 0 && !value.includes('\\') && !value.includes(':')
    && value.split('/').every(part => part.length > 0 && part !== '.' && part !== '..')
}

/** Creates retained Git worktrees under the mounted filesystem and sandbox providers. */
export class WorktreeService extends Service {
  static inject = ['workingDirectory', 'fs', 'subprocess', 'sandbox', 'sandboxPolicy']

  static Config: z<Config> = z.object({
    directory: z.string().required(),
    namePrefix: z.string().required(),
    gitCommand: z.string().required(),
    nodeCommand: z.string().required(),
    timeoutMs: z.number().required(),
    graceMs: z.number().required(),
    maxOutputBytes: z.number().required(),
  })

  private readonly config: Config
  private readonly lifetime = new AbortController()
  private readonly pending = new Set<Promise<CreatedWorktree>>()

  constructor(ctx: Context, config: Config) {
    super(ctx, 'worktrees')
    this.config = config
    if (!relativePath(this.config.directory)) throw new Error('worktree: directory must be a relative directory without dot segments')
    if (!relativePath(`${this.config.namePrefix}name`) || this.config.namePrefix.startsWith('-')) {
      throw new Error('worktree: namePrefix must produce a relative branch name')
    }
    for (const key of ['gitCommand', 'nodeCommand'] as const) {
      if (this.config[key].trim().length === 0) throw new Error(`worktree: ${key} must not be empty`)
    }
    for (const key of ['timeoutMs', 'graceMs', 'maxOutputBytes'] as const) {
      const value = this.config[key]
      const maximum = key === 'maxOutputBytes' ? Number.MAX_SAFE_INTEGER : MAX_TIMER_DELAY_MS
      if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
        throw new Error(`worktree: ${key} must be a positive integer no greater than ${maximum}`)
      }
    }
    ctx.effect(() => async () => {
      this.lifetime.abort(new Error('worktree service disposed'))
      await Promise.allSettled(this.pending)
    })
  }

  /**
   * Create a fresh branch and checkout at a pinned local revision, then enter it.
   * Existing branches or checkout paths fail. Uncommitted files stay in the source checkout.
   * Checkout disables configured clean, smudge, and process filters without changing Git config.
   * Repository-local replacement refs still apply; baseCommit reports the resolved object name.
   * The new checkout becomes current only after Git setup succeeds. Failures may retain newly
   * allocated Git/filesystem artifacts; no branch or checkout is removed automatically.
   * The allocated checkout keeps the device and inode identity its allocation reported, and its
   * Git administration directory must be the one Git registered for it; a replaced destination or
   * pointer fails the operation before any file is written.
   * @param agent - caller whose current directory selects the source repository and file policy.
   * @param request - optional new name and local revision; defaults are generated name and HEAD.
   * @param signal - cancellation of lookup, creation, and working-directory publication.
   * @returns canonical checkout path, branch name, pinned commit, and source repository root.
   */
  async create(agent: Agent, request: CreateWorktreeRequest = {}, signal?: AbortSignal): Promise<CreatedWorktree> {
    const operationSignal = signal === undefined ? this.lifetime.signal : AbortSignal.any([this.lifetime.signal, signal])
    operationSignal.throwIfAborted()
    const operation = this.createCheckout(agent, this.resolve(request), operationSignal)
    this.pending.add(operation)
    try {
      return await operation
    } finally {
      this.pending.delete(operation)
    }
  }

  private resolve(request: CreateWorktreeRequest): WorktreeSpec {
    const branch = request.name ?? `${this.config.namePrefix}${randomUUID()}`
    if (!relativePath(branch) || branch.startsWith('-')) throw new Error('worktree name must be a relative Git branch name')
    const revision = request.from ?? 'HEAD'
    if (revision.length === 0) throw new Error('worktree from must name a local commit, branch, or tag')
    return { branch, revision }
  }

  private async createCheckout(agent: Agent, { branch, revision }: WorktreeSpec, signal: AbortSignal): Promise<CreatedWorktree> {
    const cwd = await this.ctx.workingDirectory.ensure(agent, signal)
    const policy = this.ctx.sandboxPolicy.resolve({ session: agent.session })
    const run = (directory: string, args: string[], allowedExitCodes?: number[], env?: NodeJS.ProcessEnv) => runCommand(
      this.ctx, this.config, policy, directory,
      [this.config.gitCommand, '--no-lazy-fetch', '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', ...args],
      signal, allowedExitCodes, env,
    )
    const runChild = async (directory: string, mode: string, ...childArguments: string[]): Promise<string> => {
      const child = await runCommand(this.ctx, this.config, policy, directory,
        [this.config.nodeCommand, '--input-type=module', '-e', WORKTREE_CHILD, '--', mode, ...childArguments],
        signal, undefined, NODE_PRELOAD_ENV,
      )
      return child.stdout
    }
    await run(cwd, ['check-ref-format', `refs/heads/${branch}`])
    const rootOutput = await run(cwd, ['rev-parse', '--show-toplevel'])
    const rootTarget = await this.ctx.fs.resolve(rootOutput.stdout.replace(/\r?\n$/, ''), { cwd, signal })
    const repositoryRoot = this.ctx.fs.processPath(rootTarget)
    const base = await run(repositoryRoot, ['rev-parse', '--verify', '--end-of-options', `${revision}^{commit}`])
    const baseCommit = base.stdout.trim()
    const existing = await run(repositoryRoot, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], [0, 1])
    if (existing.exitCode === 0) throw new Error(`worktree branch already exists: ${branch}`)
    const pool = await this.ctx.fs.resolve(this.config.directory, { cwd: repositoryRoot, signal })
    const poolPath = this.ctx.fs.processPath(pool)
    const destination = await this.ctx.fs.resolve(branch, { cwd: poolPath, signal })
    const path = this.ctx.fs.processPath(destination)
    if (await this.ctx.fs.lstat(path, undefined, signal) !== undefined) throw new Error(`worktree path already exists: ${path}`)
    if (!this.ctx.waterfall('working-directory/before-change', agent, path, signal, () => true)) {
      throw new Error('worktree: directory change rejected by the Session policy')
    }
    signal.throwIfAborted()
    try {
      const identity = parseAllocation(await runChild(repositoryRoot, 'allocate', poolPath, path))
      await run(repositoryRoot, ['--work-tree', repositoryRoot, 'worktree', 'add', '--no-checkout', '-b', branch, '--', path, baseCommit])
      const commonDirectory = (await run(repositoryRoot, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).stdout.trim()
      const registration = parseInspection(await runChild(repositoryRoot, 'report', path, commonDirectory))
      this.requireUnchangedIdentity(registration, identity, path)
      if (registration.registeredCount !== 1 || registration.registered === null || registration.registeredKey === null) {
        throw new Error(`worktree: Git registered no single administration directory for ${path}`)
      }
      const administration = registration.registered
      const administrationKey = registration.registeredKey
      this.requireRegisteredAdministration(registration, administrationKey, path)
      const configured = await run(path, ['--git-dir', administration, 'config', '--null', '--name-only', '--get-regexp', '^filter\\.'], [0, 1])
      const drivers = new Set<string>()
      for (const key of configured.stdout.split('\0')) {
        const separator = key.lastIndexOf('.')
        if (separator > 'filter.'.length && ['clean', 'smudge', 'process', 'required'].includes(key.slice(separator + 1))) {
          drivers.add(key.slice('filter.'.length, separator))
        }
      }
      const overrides: NodeJS.ProcessEnv = { GIT_CONFIG_COUNT: String(drivers.size * 4) }
      let index = 0
      for (const driver of drivers) {
        for (const attribute of ['clean', 'smudge', 'process', 'required']) {
          overrides[`GIT_CONFIG_KEY_${index}`] = `filter.${driver}.${attribute}`
          overrides[`GIT_CONFIG_VALUE_${index}`] = attribute === 'required' ? 'false' : ''
          index++
        }
      }
      const materialization = parseInspection(await runChild(repositoryRoot, 'report', path, commonDirectory))
      this.requireUnchangedIdentity(materialization, identity, path)
      this.requireRegisteredAdministration(materialization, administrationKey, path)
      await run(path, ['--git-dir', administration, '--work-tree', path, 'reset', '--hard', '--no-recurse-submodules', baseCommit], undefined, overrides)
      const canonicalPath = await this.ctx.workingDirectory.set(agent, path, signal)
      return { path: canonicalPath, branch, baseCommit, repositoryRoot }
    } catch (error) {
      throw new Error(`Could not finish worktree ${branch} at ${path}. Any created checkout and branch are retained. ${error instanceof Error ? error.message : String(error)}`, { cause: error })
    }
  }

  /**
   * Require that a checkout still carries the identity its allocation reported.
   * @param inspection - the checkout facts the child reported.
   * @param identity - the device and inode the allocation reported.
   * @param path - checkout path, named in the failure message.
   * @throws when the checkout path is no longer the allocated directory.
   */
  private requireUnchangedIdentity(inspection: CheckoutInspection, identity: DirectoryIdentity, path: string): void {
    if (inspection.directory && inspection.dev === identity.dev && inspection.ino === identity.ino) return
    throw new Error(`worktree: the allocated checkout ${path} was replaced before its files were written`)
  }

  /**
   * Require that a checkout names the Git administration directory Git registered for it.
   * @param inspection - the checkout facts the child reported.
   * @param administrationKey - comparison key of the registered administration directory.
   * @param path - checkout path, named in the failure message.
   * @throws when the checkout names any other administration directory.
   */
  private requireRegisteredAdministration(inspection: CheckoutInspection, administrationKey: string, path: string): void {
    if (inspection.pointerKey === administrationKey) return
    throw new Error(`worktree: the checkout ${path} does not name the Git administration directory Git registered for it`)
  }
}

export default WorktreeService
