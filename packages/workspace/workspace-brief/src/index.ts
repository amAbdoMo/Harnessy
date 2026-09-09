/**
 * Read-only Workspace Brief runner and `/workspace-brief` human command.
 * The selected session's registered workspace is the only accepted root;
 * every observation is bounded and the existing command log owns persistence.
 * @module @deepseek-ai/dsh-workspace-brief
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import { FsError, type FsDirEntry, type FsTarget } from '@deepseek-ai/dsh-fs'
import type { ShellRunResult } from '@deepseek-ai/dsh-shell'
import type { Workspace } from '@deepseek-ai/dsh-workspace'

export const name = 'workspace-brief'
export const inject = ['commands', 'fs', 'sandboxPolicy', 'shell', 'workspaceRegistry']

const COMMAND = 'workspace-brief'
const USAGE = 'Usage: /workspace-brief [--git]'
const TIMEOUT_MS = 5_000
const MANIFEST_MAX_BYTES = 32 * 1_024
const GIT_OUTPUT_MAX_BYTES = 32 * 1_024
const BRIEF_MAX_CHARS = 16 * 1_024
const INVENTORY_ROWS = 12
const GIT_STATUS_ROWS = 20
const FIELD_MAX_CHARS = 320
const KNOWN_MANIFESTS = new Set([
  'Cargo.toml',
  'composer.json',
  'deno.json',
  'deno.jsonc',
  'go.mod',
  'package.json',
  'pyproject.toml',
  'requirements.txt',
])

interface GitSummary {
  readonly root: string
  readonly branch: string
  readonly rows: readonly string[]
  readonly truncated: boolean
}

interface ManifestSummary {
  readonly lines: readonly string[]
  readonly warning?: string
}

interface BriefOptions {
  readonly includeGitStatus: boolean
}

interface BriefView {
  readonly workspaceTitle: string
  readonly root: FsTarget
  readonly entries: readonly FsDirEntry[]
  readonly git: GitSummary
  readonly manifest: ManifestSummary
  readonly options: BriefOptions
}

/** Only the empty suffix and the exact optional status flag are valid. */
function parseInput(rawInput: string): BriefOptions | undefined {
  const input = rawInput.trim()
  if (input.length === 0) return { includeGitStatus: false }
  return input === '--git' ? { includeGitStatus: true } : undefined
}

/** Stable Markdown inline-code wrapper for untrusted repository-owned names. */
function code(rawText: string): string {
  const normalized = rawText.replace(/[\r\n\u0000]/gu, ' ').slice(0, FIELD_MAX_CHARS)
  const longest = Math.max(0, ...[...normalized.matchAll(/`+/gu)].map(match => match[0].length))
  const fence = '`'.repeat(longest + 1)
  return `${fence}${normalized}${fence}`
}

/** Stable fenced block whose delimiter cannot be closed by a repository filename. */
function fenced(rawText: string): string {
  const normalized = rawText.replace(/\u0000/gu, '\uFFFD')
  const longest = Math.max(2, ...[...normalized.matchAll(/`+/gu)].map(match => match[0].length))
  const fence = '`'.repeat(longest + 1)
  return `${fence}text\n${normalized}\n${fence}`
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function abortReason(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason
  return new Error(typeof signal.reason === 'string' ? signal.reason : 'workspace brief cancelled')
}

function withAbort<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortReason(signal))
  return new Promise<T>((resolve, reject) => {
    const aborted = (): void => reject(abortReason(signal))
    signal.addEventListener('abort', aborted, { once: true })
    void work.then(
      value => {
        signal.removeEventListener('abort', aborted)
        resolve(value)
      },
      error => {
        signal.removeEventListener('abort', aborted)
        reject(error)
      },
    )
  })
}

function outputText(gitRun: ShellRunResult): string {
  return `${gitRun.stdout.text}\n${gitRun.stderr.text}`.trim()
}

function isNotGit(gitRun: ShellRunResult): boolean {
  return /not a git repository|not a git directory/iu.test(outputText(gitRun))
}

function gitFailure(gitRun: ShellRunResult): CommandResult | undefined {
  if (gitRun.aborted) throw new Error('workspace brief cancelled')
  if (gitRun.timedOut) {
    return { kind: 'error', text: `Workspace brief timed out after ${gitRun.timeoutMs} ms.` }
  }
  if (gitRun.sandbox?.runnerFailed === true) {
    return { kind: 'error', text: 'Workspace brief could not start Git because the sandbox runner failed.' }
  }
  if (gitRun.sandbox?.denied === true) {
    return { kind: 'error', text: 'Workspace brief permission denied by the current sandbox policy.' }
  }
  if (gitRun.exitCode !== 0) {
    if (isNotGit(gitRun)) {
      return { kind: 'error', text: 'Workspace brief is unavailable: the selected workspace is not a Git repository.' }
    }
    return {
      kind: 'error',
      text: `Workspace brief Git inspection failed (exit ${gitRun.exitCode ?? 'signal'}): ${outputText(gitRun).slice(0, 500) || 'no diagnostic output'}`,
    }
  }
  return undefined
}

function parseGit(gitRun: ShellRunResult, options: BriefOptions): GitSummary | undefined {
  const lines = gitRun.stdout.text.replace(/\r/gu, '').split('\n').filter(line => line.length > 0)
  const branchIndex = lines.findIndex(line => line.startsWith('## '))
  if (branchIndex < 1) return undefined
  const branchLine = lines[branchIndex] as string
  const branch = branchLine.slice(3).split('...')[0]?.trim() || '(detached)'
  const status = options.includeGitStatus ? lines.slice(branchIndex + 1, branchIndex + 1 + GIT_STATUS_ROWS) : []
  return {
    root: lines[0] as string,
    branch,
    rows: status,
    truncated: gitRun.stdout.truncated || (options.includeGitStatus && lines.length > branchIndex + 1 + GIT_STATUS_ROWS),
  }
}

function manifestString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function summarizePackageJson(text: string): ManifestSummary {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error: unknown) {
    return { lines: [], warning: `package.json is invalid JSON: ${errorText(error)}` }
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { lines: [], warning: 'package.json must contain a JSON object.' }
  }
  const record = parsed as Record<string, unknown>
  const lines: string[] = []
  for (const [label, key] of [['Name', 'name'], ['Version', 'version'], ['Package manager', 'packageManager']] as const) {
    const value = manifestString(record, key)
    if (value !== undefined) lines.push(`- ${label}: ${code(value)}`)
  }
  const scripts = record['scripts']
  if (typeof scripts === 'object' && scripts !== null && !Array.isArray(scripts)) {
    const names = Object.keys(scripts).sort().slice(0, 8)
    if (names.length > 0) lines.push(`- Scripts: ${names.map(code).join(', ')}`)
    if (Object.keys(scripts).length > names.length) lines.push(`- Scripts: ${Object.keys(scripts).length - names.length} more not shown`)
  }
  return { lines: lines.length > 0 ? lines : ['- No supported package metadata fields were present.'] }
}

function classifyManifestError(error: unknown): string {
  if (error instanceof FsError) {
    switch (error.code) {
      case 'FS_TOO_LARGE': return `package.json exceeds the ${MANIFEST_MAX_BYTES}-byte read limit.`
      case 'FS_PERMISSION_DENIED':
      case 'FS_SANDBOX_DENIED': return 'package.json could not be read under the current permissions.'
      case 'FS_NOT_TEXT': return 'package.json is not valid UTF-8 text.'
      case 'FS_ABORTED': throw error
      default: return `package.json could not be read (${error.code}).`
    }
  }
  return `package.json could not be read: ${errorText(error)}`
}

function boundedBrief(lines: readonly string[]): string {
  const complete = lines.join('\n')
  if (complete.length <= BRIEF_MAX_CHARS) return complete
  const suffix = '\n\n> Partial: output was truncated by the Workspace Brief size limit.'
  return complete.slice(0, BRIEF_MAX_CHARS - suffix.length) + suffix
}

function renderBrief(view: BriefView): string {
  const visibleEntries = view.entries.filter(entry => entry.name !== '.git').slice(0, INVENTORY_ROWS)
  const manifestNames = view.entries.filter(entry => KNOWN_MANIFESTS.has(entry.name)).map(entry => entry.name)
  const hiddenEntryCount = view.entries.length - 1 - visibleEntries.length
  const lines = [
    '# Workspace Brief',
    '',
    `- Workspace: ${code(view.workspaceTitle)}`,
    `- Root: ${code(view.root.displayPath)}`,
    `- Repository: ${code(view.git.root)}`,
    `- Branch: ${code(view.git.branch)}`,
    '',
    '## Top-level inventory',
    '',
    ...visibleEntries.map(entry => `- ${entry.type === 'directory' ? 'Directory' : entry.type === 'file' ? 'File' : 'Other'}: ${code(entry.name)}`),
    ...(hiddenEntryCount > 0 ? [`- ${hiddenEntryCount} more entries not shown`] : []),
    '',
    '## Manifests',
    '',
    ...(manifestNames.length > 0 ? [`- Detected: ${manifestNames.map(code).join(', ')}`] : ['- No supported top-level manifest detected.']),
    ...view.manifest.lines,
    ...(view.manifest.warning === undefined ? [] : [`> Partial: ${view.manifest.warning}`]),
    '',
    '## Git status',
    '',
    ...(view.options.includeGitStatus
      ? [view.git.rows.length === 0 ? 'Working tree is clean.' : fenced(view.git.rows.join('\n'))]
      : ['Not requested. Run `/workspace-brief --git` to include a bounded working-tree status.']),
    ...(view.git.truncated ? ['', '> Partial: Git output was truncated by the Workspace Brief limit.'] : []),
  ]
  return boundedBrief(lines)
}

/** Production runner shared by the slash command and any future trusted UI adapter. */
export class WorkspaceBriefRunner {
  constructor(private readonly ctx: Context) {}

  async run(invocation: CommandInvocation): Promise<CommandResult> {
    const parsed = parseInput(invocation.rawInput)
    if (parsed === undefined) return { kind: 'error', text: USAGE }
    if (invocation.signal.aborted) throw abortReason(invocation.signal)

    let timeoutReached = false
    const timeout = new AbortController()
    const timer = setTimeout(() => {
      timeoutReached = true
      timeout.abort(new Error('workspace brief timed out'))
    }, TIMEOUT_MS)
    const signal = AbortSignal.any([invocation.signal, timeout.signal])
    try {
      return await withAbort(this.build(invocation, parsed, signal), signal)
    } catch (error: unknown) {
      if (invocation.signal.aborted) throw abortReason(invocation.signal)
      if (timeoutReached) return { kind: 'error', text: `Workspace brief timed out after ${TIMEOUT_MS} ms.` }
      if (error instanceof FsError) {
        if (error.code === 'FS_PERMISSION_DENIED' || error.code === 'FS_SANDBOX_DENIED') {
          return { kind: 'error', text: 'Workspace brief permission denied while reading the selected workspace.' }
        }
        if (error.code === 'FS_ABORTED') throw error
        return { kind: 'error', text: `Workspace brief filesystem failure (${error.code}): ${error.message}` }
      }
      throw error
    } finally {
      clearTimeout(timer)
    }
  }

  private async build(
    invocation: CommandInvocation,
    options: BriefOptions,
    signal: AbortSignal,
  ): Promise<CommandResult> {
    const session = invocation.agent.session
    const cwd = session.header.cwd
    if (cwd === undefined || cwd.trim().length === 0) {
      return { kind: 'error', text: 'Workspace brief is unavailable: this session has no selected workspace.' }
    }

    let workspace: Workspace | undefined
    try {
      workspace = await this.ctx.workspaceRegistry.resolveByPath(cwd)
    } catch (error: unknown) {
      if (signal.aborted) throw abortReason(signal)
      return { kind: 'error', text: `Workspace brief is unavailable: the selected workspace directory cannot be resolved (${errorText(error)}).` }
    }
    if (signal.aborted) throw abortReason(signal)
    if (workspace === undefined) {
      return { kind: 'error', text: 'Workspace brief is unavailable: this session is not attached to a registered workspace.' }
    }
    const workspaceStatus = await workspace.status()
    if (signal.aborted) throw abortReason(signal)
    if (workspaceStatus !== 'ok') {
      return { kind: 'error', text: 'Workspace brief is unavailable: the selected workspace directory is missing.' }
    }

    const root = await this.ctx.fs.resolve('.', { cwd, signal })
    const entries = await this.ctx.fs.listDir(root, signal)
    if (!entries.some(entry => entry.name === '.git')) {
      return { kind: 'error', text: 'Workspace brief is unavailable: the selected workspace is not a Git repository.' }
    }

    const gitResult = await this.runGit(invocation, root, options, signal)
    const failure = gitFailure(gitResult)
    if (failure !== undefined) return failure
    const git = parseGit(gitResult, options)
    if (git === undefined) {
      return { kind: 'error', text: 'Workspace brief Git inspection returned an unexpected response.' }
    }

    const manifest = await this.readManifest(entries, cwd, signal)
    return { kind: 'success', text: renderBrief({ workspaceTitle: workspace.title, root, entries, git, manifest, options }) }
  }

  private runGit(
    invocation: CommandInvocation,
    root: FsTarget,
    options: BriefOptions,
    signal: AbortSignal,
  ): Promise<ShellRunResult> {
    const untracked = options.includeGitStatus ? 'normal' : 'no'
    const command = `git rev-parse --show-toplevel; git -c color.ui=false status --short --branch --untracked-files=${untracked}`
    const sandboxPolicy = this.ctx.sandboxPolicy.resolve({ session: invocation.agent.session })
    return this.ctx.shell.run(this.ctx.shell.resolve({
      command,
      workdir: this.ctx.fs.processPath(root),
      timeoutMs: TIMEOUT_MS,
      stdoutMaxBytes: GIT_OUTPUT_MAX_BYTES,
      signal,
      sandboxPolicy,
    }))
  }

  private async readManifest(
    entries: readonly FsDirEntry[],
    cwd: string,
    signal: AbortSignal,
  ): Promise<ManifestSummary> {
    const entry = entries.find(candidate => candidate.name === 'package.json')
    if (entry === undefined) return { lines: [] }
    try {
      const pathInfo = await this.ctx.fs.lstat('package.json', { cwd }, signal)
      if (pathInfo?.type !== 'file' || entry.type !== 'file') {
        return { lines: [], warning: pathInfo?.type === 'symlink'
          ? 'package.json is a symbolic link and was not followed.'
          : 'package.json is not a regular file.' }
      }
      const bytes = await this.ctx.fs.readBytes(entry.target, signal, MANIFEST_MAX_BYTES)
      const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
      return summarizePackageJson(text)
    } catch (error: unknown) {
      return { lines: [], warning: classifyManifestError(error) }
    }
  }
}

/** Register one effect-owned global command; disposal removes it cleanly. */
export function apply(ctx: Context): void {
  const runner = new WorkspaceBriefRunner(ctx)
  ctx.commands.register({
    name: COMMAND,
    description: 'create a bounded read-only brief for the selected workspace',
    input: { hint: '[--git]' },
    handler: invocation => runner.run(invocation),
  })
}
