/** Shell-owned Stop feedback remains visible when the preview tab closes. */
import { Toast } from '@deepseek-ai/dsh-client-ui-primitives'
import type { HostObservable, InjectFace, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from './copy.ts'

/** One completed explicit launcher-stop action. */
export interface DevicePreviewStopNotice { readonly sequence: number; readonly success: boolean; readonly url: string }
/** Plain callbacks and a framework-bound private notice source. */
export interface DevicePreviewNoticeInjected {
  readonly dismiss: (sequence: number) => void
  readonly hooks: { readonly stopNotice: HostObservable<DevicePreviewStopNotice | undefined> }
}
/** Locale and injected feedback data derived by the registration. */
export type DevicePreviewNoticeProps = PropsLocale<'devicePreview'> & InjectFace<DevicePreviewNoticeInjected>
/** @param props - live notice, localized copy and dismissal. @returns a transient banner or nothing. */
export function DevicePreviewNotice({ useStopNotice, dismiss, t }: DevicePreviewNoticeProps) {
  const notice = useStopNotice(value => value)
  return notice === undefined ? null : <Toast key={notice.sequence} text={t(notice.success ? 'stop.success' : 'stop.failed', { url: notice.url })}
    {...notice.success ? { tone: 'success' as const } : {}} onDone={() => { dismiss(notice.sequence) }} />
}
