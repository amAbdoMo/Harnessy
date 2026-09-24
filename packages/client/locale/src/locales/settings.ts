/** `settings.locale` namespace dictionary for the Language row. */
export const en = {
  'language.title': 'Language',
} satisfies Record<string, string>

/** The settings.locale namespace key union. */
export type SettingsLocaleKey = keyof typeof en

/** Dormant Simplified Chinese counterpart retained for dictionary parity. */
export const zh: Record<SettingsLocaleKey, string> = {
  'language.title': '语言',
}
