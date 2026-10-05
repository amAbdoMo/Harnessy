/** Saved-profile picker and create form inside the Browser toolbar. */
import { useState } from 'react'
import type { ReactNode } from 'react'
import {
  Button, IconCheckOutlineRegular, IconUserOutlineRegular, Input, Menu, MenuItemButton, Modal, Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { MenuEntry } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import type { createWebsiteProfileDraftStore } from '../browser/profile-draft.ts'
import type {
  DesktopWebsiteControl, DesktopWebsiteProfile, DesktopWebsiteProfileId, DesktopWebsiteProfileInput,
} from '../../types.ts'
import type { BrowserInjected } from '../browser/BrowserController.ts'
import type { WebsiteProfileCommands } from '../browser/profiles.ts'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import css from './Browser.module.css'

/** Private saved-profile commands and observable facts for the toolbar contribution. */
export interface BrowserProfilePickerInjected {
  readonly profiles: WebsiteProfileCommands
  readonly hooks: BrowserInjected['hooks']
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    /**
     * Replace the Browser toolbar's saved-profile picker. The owner passes the current
     * profile identity and a callback opening the selected account in its own tab.
     * The session-scoped contribution receives standard hooks; absence leaves no picker.
     */
    'sidebar.right.pane.tab.browser.profiles': {
      kind: 'single'
      scope: 'session'
      owner: {
        readonly profileId: DesktopWebsiteProfileId | undefined
        readonly openProfile: (profile: DesktopWebsiteProfile) => void
      }
    }
  }
}

/** Toolbar picker inputs derived from its registration. */
export type BrowserProfilePickerProps = PropsRuntime<'sidebar.right.pane.tab.browser.profiles'>
  & PropsStore<ReturnType<typeof createWebsiteProfileDraftStore>>
  & PropsLocale<'sidebarBrowser'> & InjectFace<BrowserProfilePickerInjected>

/** Row detail for one control state; agent control shows the account label instead. */
function controlDetail(profile: DesktopWebsiteProfile, t: BrowserProfilePickerProps['t']): string {
  const control: DesktopWebsiteControl = profile.control
  switch (control) {
    case 'human': return t('profiles.detail.human')
    case 'agent': return profile.accountLabel
    case 'clearing': return t('profiles.detail.clearing')
    case 'cleanup-failed': return t('profiles.detail.cleanupFailed')
    /* v8 ignore next 2 -- closed-union backstop; only reached if a control state is forged */
    default: return assertNever(control)
  }
}

/** One saved profile's row: its name, its state or account, and whether this tab uses it. */
function profileRow(profile: DesktopWebsiteProfile, current: boolean, t: BrowserProfilePickerProps['t']): ReactNode {
  const detail = controlDetail(profile, t)
  return (
    <span className={css.profileRow}>
      <span className={css.profileName}>{profile.name}</span>
      {detail !== '' && <span className={css.profileDetail}>{detail}</span>}
      {current && <IconCheckOutlineRegular className={css.profileCheck} size={12} />}
    </span>
  )
}

/** Saved-profile picker: every saved account, its cleanup states, and the create entry. */
export function BrowserProfilePicker({
  profiles, profileId, openProfile, useWebsiteProfiles, useStore, actions, t,
}: BrowserProfilePickerProps): ReactNode {
  const state = useWebsiteProfiles(current => current)
  const draft = useStore(current => current)
  const [open, setOpen] = useState(false)
  const [creating, setCreating] = useState(false)
  // One operation at a time: a second request would race the first one's result.
  const blocked = state.creating || state.busy !== undefined
  const heading: MenuEntry[] = state.profiles.length === 0
    ? [{
      id: 'status',
      disabled: true,
      label: state.phase === 'failed' ? t('profiles.loadFailed')
        : state.phase === 'loading' ? t('profiles.loading') : t('profiles.empty'),
    }]
    : [{ type: 'label', id: 'saved', text: t('profiles.saved') }]

  const create = (input: DesktopWebsiteProfileInput): void => {
    void profiles.create(input).then((created) => {
      // A refused save keeps the form open for correction; its notice names the reason.
      if (created === undefined) return
      actions.discard()
      setCreating(false)
      openProfile(created)
    })
  }

  return (
    <>
      <Menu
        open={open}
        onClose={() => { setOpen(false) }}
        items={heading}
        anchor={(
          <Tooltip label={t('profiles.button')} side="bottom" delayMs={500}>
            <button
              type="button"
              className={css.tool}
              aria-label={t('profiles.button')}
              aria-haspopup="menu"
              aria-expanded={open}
              onClick={() => { setOpen(value => !value) }}
            ><IconUserOutlineRegular size={15} /></button>
          </Tooltip>
        )}
      >
        {state.profiles.map(profile => (
          <MenuItemButton
            key={profile.id}
            disabled={blocked || profile.control === 'clearing' || profile.control === 'cleanup-failed'}
            onSelect={() => { setOpen(false); openProfile(profile) }}
          >{profileRow(profile, profile.id === profileId, t)}</MenuItemButton>
        ))}
        {state.phase === 'failed' && (
          <MenuItemButton separatorBefore disabled={blocked} onSelect={() => { void profiles.reload() }}>
            {t('retry')}
          </MenuItemButton>
        )}
        {state.profiles.filter(profile => profile.control === 'cleanup-failed').map(profile => (
          <MenuItemButton
            key={`cleanup-${profile.id}`}
            separatorBefore
            disabled={blocked}
            onSelect={() => { void profiles.signOut(profile.id) }}
          >{t('profiles.retryCleanup', { name: profile.name })}</MenuItemButton>
        ))}
        <MenuItemButton separatorBefore onSelect={() => { setOpen(false); setCreating(true) }}>
          {t('profiles.new')}
        </MenuItemButton>
      </Menu>
      {creating && (
        <BrowserProfileCreate draft={draft} edit={actions.edit} creating={state.creating} onCreate={create}
          onClose={() => { actions.discard(); setCreating(false) }} t={t} />
      )}
    </>
  )
}

/** The create form: a saved profile is a user-confirmed pairing, never a discovered one. */
function BrowserProfileCreate({ draft, edit, creating, onCreate, onClose, t }: {
  readonly draft: DesktopWebsiteProfileInput
  readonly edit: BrowserProfilePickerProps['actions']['edit']
  readonly creating: boolean
  readonly onCreate: (input: DesktopWebsiteProfileInput) => void
  readonly onClose: () => void
  readonly t: BrowserProfilePickerProps['t']
}): ReactNode {
  const { name, accountLabel, url, mcpServerName } = draft
  const complete = name.trim() !== '' && url.trim() !== '' && mcpServerName.trim() !== ''
  const blocked = creating || !complete
  const submit = (): void => {
    if (blocked) return
    onCreate({ name: name.trim(), accountLabel: accountLabel.trim(), url: url.trim(), mcpServerName: mcpServerName.trim() })
  }
  return (
    <Modal
      open
      onClose={() => { if (!creating) onClose() }}
      closeLabel={t('close')}
      title={t('profiles.create.title')}
      description={t('profiles.create.description')}
      footer={(
        <>
          <Button variant="outline" disabled={creating} onClick={onClose}>{t('cancel')}</Button>
          <Button variant="primary" disabled={blocked} onClick={submit}>{t('profiles.create.action')}</Button>
        </>
      )}
    >
      <div className={css.profileForm} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); submit() } }}>
        <label className={css.profileField}>
          <span className={css.profileFieldLabel}>{t('profiles.create.name')}</span>
          <Input value={name} disabled={creating} data-modal-autofocus onChange={(event) => { edit('name', event.currentTarget.value) }} />
        </label>
        <label className={css.profileField}>
          <span className={css.profileFieldLabel}>{t('profiles.create.accountLabel')}</span>
          <Input value={accountLabel} disabled={creating} onChange={(event) => { edit('accountLabel', event.currentTarget.value) }} />
        </label>
        <label className={css.profileField}>
          <span className={css.profileFieldLabel}>{t('profiles.create.url')}</span>
          <Input value={url} aria-label={t('profiles.create.url')} disabled={creating} onChange={(event) => { edit('url', event.currentTarget.value) }} />
          <span className={css.profileFieldHint}>{t('profiles.create.urlHint')}</span>
        </label>
        <label className={css.profileField}>
          <span className={css.profileFieldLabel}>{t('profiles.create.mcp')}</span>
          <Input value={mcpServerName} aria-label={t('profiles.create.mcp')} disabled={creating} onChange={(event) => { edit('mcpServerName', event.currentTarget.value) }} />
          <span className={css.profileFieldHint}>{t('profiles.create.mcpHint')}</span>
        </label>
      </div>
    </Modal>
  )
}
