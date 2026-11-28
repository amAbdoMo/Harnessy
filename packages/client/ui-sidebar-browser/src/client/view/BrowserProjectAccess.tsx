/** Browser settings for agent access by registered project. */
import { useCallback, useEffect, useId, useState, useSyncExternalStore, type ReactNode } from 'react'
import type { WorkspaceSource } from '@deepseek-ai/dsh-api-workspace-controller/client'
import { workspaceDisplayTitle } from '@deepseek-ai/dsh-api-workspace-controller/default-workspace'
import { Button, Select, Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { BrowserProjectAccessBridge, BrowserProjectId } from '../../types.ts'
import css from './Browser.module.css'

/** @param props - native preference commands, project list and browser copy.
 * @returns the project selector and committed access setting.
 */
export function BrowserProjectAccess({ t, access, projects }: Pick<PropsLocale<'sidebarBrowser'>, 't'>
  & { readonly access: BrowserProjectAccessBridge; readonly projects: WorkspaceSource }): ReactNode {
  const id = useId()
  const snapshot = useSyncExternalStore(useCallback(listener => projects.subscribe(listener), [projects]),
    useCallback(() => projects.getSnapshot(), [projects]))
  const [selectedId, setSelectedId] = useState('')
  const [disabled, setDisabled] = useState<readonly BrowserProjectId[]>()
  const [attempt, setAttempt] = useState(0)
  const [failed, setFailed] = useState(false)
  const [saving, setSaving] = useState(false)
  const selected = snapshot.items.find(item => item.workspaceId === selectedId) ?? snapshot.items[0]
  useEffect(() => {
    let current = true
    void access.list().then((projects) => { if (current) setDisabled(projects) }, () => { if (current) setFailed(true) })
    return () => { current = false }
  }, [access, attempt])

  const save = async (projectId: BrowserProjectId, enabled: boolean): Promise<void> => {
    setSaving(true)
    setFailed(false)
    try { setDisabled(await access.set(projectId, enabled)) }
    catch (_error: unknown) { setFailed(true) }
    finally { setSaving(false) }
  }

  return <section className={css.profileField} aria-labelledby={`${id}-heading`}>
    <h3 id={`${id}-heading`} className={css.defaultsHeading}>{t('projectAccess.title')}</h3>
    <span className={css.profileFieldHint}>{t('projectAccess.hint')}</span>
    {selected === undefined && snapshot.phase === 'ready' && <span className={css.profileFieldHint}>{t('projectAccess.noProjects')}</span>}
    {selected !== undefined && <>
      <label className={css.profileFieldLabel} htmlFor={`${id}-project`}>{t('projectAccess.project')}</label>
      <Select id={`${id}-project`} value={selected.workspaceId} disabled={saving}
        options={snapshot.items.map(item => ({ value: item.workspaceId, label: workspaceDisplayTitle(item.title, t('projectAccess.defaultProject')) }))}
        onChange={setSelectedId} />
      {disabled !== undefined && <div className={css.defaultsToggle}>
        <span className={css.profileFieldLabel}>{t('projectAccess.allow')}</span>
        <Switch label={t('projectAccess.allow')} checked={!disabled.includes(selected.workspaceId)} disabled={saving}
          onChange={(enabled) => { void save(selected.workspaceId, enabled) }} />
      </div>}
    </>}
    {failed && <div className={css.profileActions}>
      <span className={css.profileFieldError} role="alert">{t(disabled === undefined ? 'projectAccess.loadFailed' : 'projectAccess.saveFailed')}</span>
      {disabled === undefined && <Button size="sm" variant="outline" onClick={() => {
        setFailed(false)
        setAttempt(value => value + 1)
      }}>{t('retry')}</Button>}
    </div>}
  </section>
}
