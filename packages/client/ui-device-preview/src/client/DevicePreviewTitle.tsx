/** Localized Device Preview title with its comparison icon. */
import { IconCompareSplitOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from './copy.ts'

/** Framework-derived title seat and locale. */
export type DevicePreviewTitleProps = PropsRuntime<'sidebar.right.pane.tab.title'> & PropsLocale<'devicePreview'>
/** @param props - title seat and live locale. @returns device-preview tab label. */
export function DevicePreviewTitle({ t }: DevicePreviewTitleProps) {
  return <><IconCompareSplitOutlineRegular size={14} />{t('title')}</>
}
