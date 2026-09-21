/** Browser-safe vocabulary and decoder for Host-owned Session workspace settings. */

/** Settings namespace controlling the location of new ungrouped Sessions. */
export const SESSION_WORKSPACE_SETTINGS_NAMESPACE = 'session-workspace'

/** Local-work locations presented by the Harnessy settings UI. */
export const SESSION_WORKSPACE_MODES = ['harnessy-default', 'remote-website'] as const

/** Local-work location selected for newly created ungrouped Sessions. */
export type SessionWorkspaceMode = typeof SESSION_WORKSPACE_MODES[number]

/** Settings fields received from the Host. */
export interface SessionWorkspaceSettings {
  /** Whether Harnessy uses its launch directory or an isolated remote-work folder. */
  readonly mode: SessionWorkspaceMode
  /** Parent directory for isolated remote-work folders. */
  readonly remoteRoot: string
}

/**
 * Narrow an untrusted settings section to the Session workspace fields.
 * @param value - unknown settings value received from the Host.
 * @returns decoded settings, or `undefined` when the section is malformed.
 */
export function decodeSessionWorkspaceSettings(value: unknown): SessionWorkspaceSettings | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const candidate = value as Partial<SessionWorkspaceSettings>
  if (candidate.mode !== SESSION_WORKSPACE_MODES[0]
    && candidate.mode !== SESSION_WORKSPACE_MODES[1]) {
    return undefined
  }
  if (typeof candidate.remoteRoot !== 'string') return undefined
  return { mode: candidate.mode, remoteRoot: candidate.remoteRoot }
}
