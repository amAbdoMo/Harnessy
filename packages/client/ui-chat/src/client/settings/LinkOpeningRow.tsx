/** General Settings row for Chat HTTP(S) link destinations. */
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { InjectFace, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { LinkOpening } from '../../chat-settings.ts'
import { PreferenceRow } from './PreferenceRow.tsx'

/** Registration-side link-opening preference. */
export interface LinkOpeningRowInjected {
  hooks: {
    /** Current destination, bound as useLinkOpening. */
    linkOpening: ObservableSnapshot<LinkOpening>
    /** Whether the built-in browser is registered, bound as useBrowserAvailable. */
    browserAvailable: ObservableSnapshot<boolean>
  }
  /** Whether the external destination is the system browser. */
  desktopBrowser?: boolean
  /** Change the default destination for Chat HTTP(S) links. */
  setLinkOpening: (destination: LinkOpening) => void
}

/** Full Settings-row props. */
export type LinkOpeningRowProps = PropsLocale<'chat'> & InjectFace<LinkOpeningRowInjected>

/**
 * Render the link-opening destination selector.
 * @param props - Composed Settings slot props.
 * @returns The preference row.
 */
export function LinkOpeningRow({ useLinkOpening, useBrowserAvailable, desktopBrowser, setLinkOpening, t }: LinkOpeningRowProps) {
  const destination = useLinkOpening(value => value)
  const browserAvailable = useBrowserAvailable(value => value)
  if (!browserAvailable) return null
  const sidebar = t(desktopBrowser ? 'settings.links.harnessy' : 'settings.links.sidebar')
  const external = t(desktopBrowser ? 'settings.links.system' : 'settings.links.newTab')
  return (
    <PreferenceRow
      title={t('settings.links.title')}
      description={t('settings.links.description')}
      value={destination}
      selectedLabel={destination === 'sidebar' ? sidebar : external}
      options={[
        { id: 'sidebar', label: sidebar },
        { id: 'new-tab', label: external },
      ]}
      onSelect={(value) => { setLinkOpening(value as LinkOpening) }}
    />
  )
}
