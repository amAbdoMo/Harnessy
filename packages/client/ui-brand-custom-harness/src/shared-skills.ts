/** Settings namespace owned by Harnessy's global shared-skills provider. */
export const SHARED_SKILLS_SETTINGS_NAMESPACE = 'harnessy-shared-skills'

/** Browser view of the Host-validated shared skill directory settings. */
export interface SharedSkillsSettings {
  /** Whether Harnessy scans the selected shared directory. */
  enabled: boolean
  /** Absolute Windows directory containing compatible skills. */
  directory: string
}

/**
 * Narrow an untrusted settings section to Harnessy's shared-skills shape.
 * @param value - unknown settings value received from the Host.
 * @returns the decoded settings, or `undefined` when the value is malformed.
 */
export function decodeSharedSkillsSettings(value: unknown): SharedSkillsSettings | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const candidate = value as Partial<SharedSkillsSettings>
  if (typeof candidate.enabled !== 'boolean' || typeof candidate.directory !== 'string') return undefined
  if (candidate.directory.trim() === '') return undefined
  return { enabled: candidate.enabled, directory: candidate.directory }
}
