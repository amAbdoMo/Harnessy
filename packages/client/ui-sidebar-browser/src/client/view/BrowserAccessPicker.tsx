/** Saved website access choice shared by account creation and the profile bar. */
import { useState, type ReactNode } from 'react'
import { Button, Menu } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-locale/client'
import type { DesktopWebsiteAccess } from '../../types.ts'

/** @param props - saved access, mutation callback and locale. @returns the three supported access choices. */
export function BrowserAccessPicker({ access, disabled, onChange, t }: {
  readonly access: DesktopWebsiteAccess
  readonly disabled: boolean
  readonly onChange: (access: DesktopWebsiteAccess) => void
  readonly t: TranslateNS<'sidebarBrowser'>
}): ReactNode {
  const [open, setOpen] = useState(false)
  const choices = ['automatic', 'ask', 'disabled'] as const
  return <Menu portal open={open} onClose={() => { setOpen(false) }}
    items={choices.map(choice => ({ id: choice, label: t(`profiles.access.${choice}`), disabled }))}
    onSelect={(id) => { const choice = choices.find(value => value === id); setOpen(false); if (choice !== undefined) onChange(choice) }}
    anchor={<Button size="sm" variant="outline" disabled={disabled} aria-haspopup="menu" aria-expanded={open}
      aria-label={t('profiles.access')} onClick={() => { setOpen(value => !value) }}>{t(`profiles.access.${access}`)}</Button>} />
}
