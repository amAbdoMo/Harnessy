/** Saved-profile picker and create form inside the Browser toolbar. */
import { useEffect, useId, useState } from 'react'
import type { ReactNode } from 'react'
import {
  Button, Checkbox, IconCheckOutlineRegular, IconUserOutlineRegular, Input, Menu, MenuItemButton, Modal, Select, Tooltip,
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
import { BrowserAccessPicker } from './BrowserAccessPicker.tsx'
import { BrowserProfileImport } from './BrowserProfileImport.tsx'
import { resolveWebsiteProfileInput, type WebsiteProfileInputIssue } from '../browser/profile-input.ts'
import { websiteProfileFailureText } from './profile-failure-text.ts'

/** Private saved-profile commands and observable facts for the toolbar contribution. */
export interface BrowserProfilePickerInjected {
  readonly profiles: WebsiteProfileCommands
  readonly hooks: BrowserInjected['hooks']
  /** @returns display names, namespaces, and pairing availability from the current MCP registry. */
  readonly listMcpServers: () => Promise<readonly WebsiteMcpOption[]>
}

interface WebsiteMcpOption {
  readonly name: string
  readonly serverName: string
  readonly connected: boolean
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
  profiles, profileId, openProfile, useWebsiteProfiles, useStore, actions, listMcpServers, t,
}: BrowserProfilePickerProps): ReactNode {
  const state = useWebsiteProfiles(current => current)
  const draft = useStore(current => current)
  const [open, setOpen] = useState(false)
  const [dialog, setDialog] = useState<'create' | 'import'>()
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

  const create = (input: DesktopWebsiteProfileInput, importFirefoxSession: boolean): void => {
    void (importFirefoxSession ? profiles.create(input, true) : profiles.create(input)).then((created) => {
      // A refused save keeps the form open for correction; its notice names the reason.
      if (created === undefined) return
      actions.discard()
      setDialog(undefined)
      openProfile(created)
    })
  }

  return (
    <>
      <Menu
        portal
        align="end"
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
        <MenuItemButton separatorBefore disabled={blocked} onSelect={() => { setOpen(false); setDialog('create') }}>
          {t('profiles.new')}
        </MenuItemButton>
        <MenuItemButton disabled={blocked} onSelect={() => { setOpen(false); setDialog('import') }}>
          {t('profiles.import.title')}
        </MenuItemButton>
      </Menu>
      {dialog === 'import' && <BrowserProfileImport t={t} onClose={() => { setDialog(undefined) }} onChoose={(site) => {
        actions.importSite(site)
        setDialog('create')
      }} />}
      {dialog === 'create' && (
        <BrowserProfileCreate draft={draft} edit={actions.edit} creating={state.creating} onCreate={create} listMcpServers={listMcpServers}
          canImportFirefoxSession={profiles.canImportFirefoxSession === true}
          onClose={() => { actions.discard(); setDialog(undefined) }} t={t} />
      )}
    </>
  )
}

/** The create form: a saved profile is a user-confirmed pairing, never a discovered one. */
function BrowserProfileCreate({ draft, edit, creating, onCreate, onClose, listMcpServers, canImportFirefoxSession, t }: {
  readonly draft: DesktopWebsiteProfileInput
  readonly edit: BrowserProfilePickerProps['actions']['edit']
  readonly creating: boolean
  readonly onCreate: (input: DesktopWebsiteProfileInput, importFirefoxSession: boolean) => void
  readonly onClose: () => void
  readonly listMcpServers: BrowserProfilePickerInjected['listMcpServers']
  readonly canImportFirefoxSession: boolean
  readonly t: BrowserProfilePickerProps['t']
}): ReactNode {
  const { name, accountLabel, url, mcpServerName } = draft
  const [importFirefoxSession, setImportFirefoxSession] = useState(false)
  const access = importFirefoxSession ? 'disabled' : draft.access ?? 'automatic'
  const [submitted, setSubmitted] = useState(false)
  const [servers, setServers] = useState<readonly WebsiteMcpOption[] | 'loading' | 'failed'>('loading')
  const [attempt, setAttempt] = useState(0)
  const errorId = useId()
  const mcpId = useId()
  const mcpHintId = useId()
  useEffect(() => {
    let active = true
    void listMcpServers().then(
      (entries) => { if (active) setServers(entries) },
      () => { if (active) setServers('failed') },
    )
    return () => { active = false }
  }, [listMcpServers, attempt])
  const choices = typeof servers === 'string' ? [] : servers
  const connected = choices.some(server => server.connected)
  const canRefresh = servers === 'failed' || (typeof servers !== 'string' && (!connected || choices.some(server => !server.connected)))
  const selected = choices.some(server => server.serverName === mcpServerName && server.connected)
  const resolved = resolveWebsiteProfileInput({ ...draft, access })
  const issue = submitted && !resolved.ok ? resolved.issue : undefined
  const errorProps = (field: WebsiteProfileInputIssue['field']) => ({
    'aria-invalid': issue?.field === field ? true : undefined,
    'aria-describedby': issue?.field === field ? errorId : undefined,
  })
  const fieldError = (field: WebsiteProfileInputIssue['field']): ReactNode => issue?.field === field
    ? <span id={errorId} role="alert" className={css.profileFieldError}>{websiteProfileFailureText(issue.reason, t)}</span> : null
  const complete = name.trim() !== '' && url.trim() !== '' && selected
  const blocked = creating || !complete
  const submit = (): void => {
    if (blocked) return
    setSubmitted(true)
    if (!resolved.ok) return
    onCreate(resolved.value, importFirefoxSession)
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
      <div className={css.profileForm} onKeyDown={(event) => {
        if (event.key === 'Enter' && event.target instanceof HTMLInputElement) { event.preventDefault(); submit() }
      }}>
        <div className={css.profileField}>
          <span className={css.profileFieldLabel}>{t('profiles.access')}</span>
          <BrowserAccessPicker access={access} disabled={creating || importFirefoxSession} onChange={(choice) => { edit('access', choice) }} t={t} />
          <span className={css.profileFieldHint}>{t('profiles.access.hint')}</span>
        </div>
        <label className={css.profileField}>
          <span className={css.profileFieldLabel}>{t('profiles.create.name')}</span>
          <Input value={name} {...errorProps('name')} disabled={creating} data-modal-autofocus onChange={(event) => { edit('name', event.currentTarget.value) }} />
          {fieldError('name')}
        </label>
        <label className={css.profileField}>
          <span className={css.profileFieldLabel}>{t('profiles.create.accountLabel')}</span>
          <Input value={accountLabel} {...errorProps('accountLabel')} disabled={creating} onChange={(event) => { edit('accountLabel', event.currentTarget.value) }} />
          {fieldError('accountLabel')}
        </label>
        <label className={css.profileField}>
          <span className={css.profileFieldLabel}>{t('profiles.create.url')}</span>
          <Input value={url} {...errorProps('url')} aria-label={t('profiles.create.url')} disabled={creating} onChange={(event) => { edit('url', event.currentTarget.value) }} />
          <span className={css.profileFieldHint}>{t('profiles.create.urlHint')}</span>
          {fieldError('url')}
        </label>
        {canImportFirefoxSession && <div className={css.profileField}>
          <Checkbox checked={importFirefoxSession} disabled={creating} onChange={setImportFirefoxSession}
            label={t('profiles.create.firefox')} />
          {importFirefoxSession && <span className={css.profileFieldHint}>{t('profiles.create.firefoxHint')}</span>}
        </div>}
        <div className={css.profileField}>
          <label htmlFor={mcpId} className={css.profileFieldLabel}>{t('profiles.create.mcp')}</label>
          <Select id={mcpId} ariaDescribedBy={mcpHintId} value={mcpServerName} disabled={creating || !connected}
            options={[{ value: '', label: t('profiles.create.mcpPlaceholder'), disabled: true }, ...choices.map(server => ({
              value: server.serverName,
              label: t(server.connected ? 'profiles.create.mcpOption' : 'profiles.create.mcpDisconnected',
                { name: server.name, serverName: server.serverName }),
              disabled: !server.connected,
            }))]}
            onChange={(serverName) => { edit('mcpServerName', serverName) }} />
          <span id={mcpHintId} className={css.profileFieldHint} role="status">
            {t(servers === 'loading' ? 'profiles.create.mcpLoading' : servers === 'failed' ? 'profiles.create.mcpFailed'
              : connected ? 'profiles.create.mcpHint' : 'profiles.create.mcpEmpty')}
          </span>
          {canRefresh && (
            <Button size="sm" variant="outline" disabled={creating} onClick={() => {
              setServers('loading')
              setAttempt(value => value + 1)
            }}>{t('retry')}</Button>
          )}
          {fieldError('mcpServerName')}
        </div>
      </div>
    </Modal>
  )
}
