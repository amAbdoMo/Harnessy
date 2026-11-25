/** Choose an exported site and review it through the standard create dialog. */
import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { Button, Modal, Select } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { MAX_BROWSER_PROFILE_IMPORT_BYTES, parseBrowserProfileImport, type ImportedBrowserSite } from '../browser/profile-import.ts'
import css from './Browser.module.css'

type ImportState =
  | { readonly kind: 'loading' | 'initial' | 'tooLarge' | 'invalid' | 'empty' }
  | { readonly kind: 'ready'; readonly sites: readonly ImportedBrowserSite[] }

/**
 * Offer website details from a file without navigating to a site or saving the profile.
 * @param props - locale, dismissal, and the callback that opens a review form.
 * @returns the file and site selection dialog.
 */
export function BrowserProfileImport({ onChoose, onClose, t }: PropsLocale<'sidebarBrowser'> & {
  readonly onChoose: (site: ImportedBrowserSite) => void
  readonly onClose: () => void
}): ReactNode {
  const [state, setState] = useState<ImportState>({ kind: 'initial' })
  const [selected, setSelected] = useState('')
  const generation = useRef(0)
  const fileId = useId()
  const siteId = useId()
  useEffect(() => () => { generation.current++ }, [])
  const read = async (file: File | undefined): Promise<void> => {
    const current = ++generation.current
    setSelected('')
    if (file === undefined) { setState({ kind: 'initial' }); return }
    if (file.size > MAX_BROWSER_PROFILE_IMPORT_BYTES) { setState({ kind: 'tooLarge' }); return }
    setState({ kind: 'loading' })
    try {
      const text = await file.text()
      if (generation.current !== current) return
      const sites = parseBrowserProfileImport(text, window.location.origin)
      if (sites === undefined) setState({ kind: 'invalid' })
      else if (sites.length === 0) setState({ kind: 'empty' })
      else {
        setSelected(sites[0]?.url ?? '')
        setState({ kind: 'ready', sites })
      }
    } catch (_error: unknown) {
      if (generation.current === current) setState({ kind: 'invalid' })
    }
  }
  const site = state.kind === 'ready' ? state.sites.find(candidate => candidate.url === selected) : undefined
  return (
    <Modal open title={t('profiles.import.title')} description={t('profiles.import.description')} onClose={onClose}
      closeLabel={t('close')} footer={<>
        <Button variant="outline" onClick={onClose}>{t('cancel')}</Button>
        <Button variant="primary" disabled={site === undefined} onClick={() => { if (site !== undefined) onChoose(site) }}>
          {t('profiles.import.review')}
        </Button>
      </>}>
      <div className={css.profileForm}>
        <div className={css.profileField}>
          <label htmlFor={fileId} className={css.profileFieldLabel}>{t('profiles.import.file')}</label>
          <input type="file" id={fileId} accept=".html,.htm,.json,text/html,application/json" data-modal-autofocus
            onChange={(event) => { void read(event.currentTarget.files?.[0]) }} />
        </div>
        {state.kind === 'ready' && <div className={css.profileField}>
          <label htmlFor={siteId} className={css.profileFieldLabel}>{t('profiles.import.site')}</label>
          <Select id={siteId} value={selected} onChange={setSelected} options={state.sites.map(({ name, url }) => ({
            value: url, label: t('profiles.import.option', { name, site: new URL(url).host }),
          }))} />
          <span className={css.profileFieldHint}>{selected}</span>
        </div>}
        {state.kind === 'loading' && <span role="status">{t('profiles.import.loading')}</span>}
        {(state.kind === 'invalid' || state.kind === 'empty' || state.kind === 'tooLarge')
          && <span className={css.profileFieldError} role="alert">{t(`profiles.import.${state.kind}`)}</span>}
      </div>
    </Modal>
  )
}
