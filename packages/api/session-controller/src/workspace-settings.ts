/** Host-owned settings and directory resolution for new ungrouped Sessions. */

import { createHash } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { SettingsScope } from '@deepseek-ai/dsh-settings'
import type { SessionId } from '@deepseek-ai/dsh-session'
import {
  DEFAULT_SESSION_WORKSPACE_MODE,
  SESSION_WORKSPACE_MODES,
  SESSION_WORKSPACE_SETTINGS_NAMESPACE,
  type SessionWorkspaceSettings,
} from './types.ts'

/** Schema shared by the Host settings provider and browser settings view. */
export const SessionWorkspaceSettingsSchema: z<SessionWorkspaceSettings> = z.object({
  mode: z.union([...SESSION_WORKSPACE_MODES]).default(DEFAULT_SESSION_WORKSPACE_MODE),
  remoteRoot: z.string().default(''),
})

/**
 * Reject remote mode when its parent directory cannot be addressed on this Host.
 * @param settings - schema-valid settings awaiting the cross-field check.
 */
export function validateSessionWorkspaceSettings(settings: SessionWorkspaceSettings): void {
  if (settings.mode !== 'remote-website') return
  if (settings.remoteRoot.trim() === '' || !isAbsolute(settings.remoteRoot)) {
    throw new Error('Remote website work needs an absolute temporary work folder')
  }
}

function remoteSessionFolder(root: string, sessionId: SessionId): string {
  const suffix = createHash('sha256').update(sessionId).digest('hex').slice(0, 12)
  return join(root, `Harnessy Remote Work - ${suffix}`)
}

/** Resolve each new ungrouped Session against the latest accepted preference. */
export class SessionWorkspaceDirectory {
  private settings: SettingsScope<SessionWorkspaceSettings> | undefined

  /**
   * @param ctx - Host context that may provide durable user settings.
   * @param defaultCwd - launch directory retained for the default mode.
   */
  constructor(ctx: Context, private readonly defaultCwd: string) {
    ctx.inject(['settings'], (settingsCtx) => {
      const scope = settingsCtx.settings.register(
        SESSION_WORKSPACE_SETTINGS_NAMESPACE,
        SessionWorkspaceSettingsSchema,
        { validate: validateSessionWorkspaceSettings },
      )
      this.settings = scope
      settingsCtx.effect(() => () => {
        if (this.settings === scope) this.settings = undefined
      }, 'session-controller: Session workspace settings')
    })
  }

  /**
   * Resolve and prepare the working directory for one new ungrouped Session.
   * @param sessionId - identity used to isolate concurrent remote-work files.
   * @returns the directory recorded in the new Session header.
   */
  async resolve(sessionId: SessionId): Promise<string> {
    const settings = this.settings?.get()
    if (settings === undefined || settings.mode === 'harnessy-default') return this.defaultCwd
    const directory = remoteSessionFolder(settings.remoteRoot, sessionId)
    await mkdir(directory, { recursive: true })
    return directory
  }
}
