/** Lane-local controls reuse shared buttons, inputs and portaled menus. */
import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { Button, Input, Menu, IconChevronDownOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import type { TabId } from '@deepseek-ai/dsh-client-ui-dockkit'
import type { DeviceLaneView, DevicePreviewStore } from './store.ts'
import type {} from './copy.ts'
import { orientedViewport, parseDimension, VIEWPORT_BOUNDS, type DeviceKind, type DeviceLane } from './viewport.ts'
import css from './DevicePreview.module.css'

/** Controls write only declared viewing actions. */
export interface DeviceControlsProps extends PropsLocale<'devicePreview'> {
  readonly tabId: TabId
  readonly lane: DeviceLane
  readonly view: DeviceLaneView
  readonly liveAvailable: boolean
  readonly actions: PropsStore<DevicePreviewStore>['actions']
}

function CustomSize(props: DeviceControlsProps): ReactNode {
  const { view, t } = props
  const viewport = orientedViewport(view.dimensions, view.orientation)
  const [width, setWidth] = useState(String(viewport.width))
  const [height, setHeight] = useState(String(viewport.height))
  const [invalid, setInvalid] = useState(false)
  const hintId = useId()
  const applySize = (event: FormEvent): void => {
    event.preventDefault()
    const parsedWidth = parseDimension(width)
    const parsedHeight = parseDimension(height)
    setInvalid(parsedWidth === undefined || parsedHeight === undefined)
    if (parsedWidth !== undefined && parsedHeight !== undefined) {
      props.actions.setDimensions(props.tabId, props.lane, orientedViewport({ width: parsedWidth, height: parsedHeight }, view.orientation))
    }
  }
  const bounds = { min: String(VIEWPORT_BOUNDS.min), max: String(VIEWPORT_BOUNDS.max) }
  return <form className={css.customSize} onSubmit={applySize}>
    <label>{t('width')}<Input value={width} inputMode="numeric" aria-invalid={invalid}
      aria-describedby={hintId} onChange={(event) => { setWidth(event.currentTarget.value) }} /></label>
    <label>{t('height')}<Input value={height} inputMode="numeric" aria-invalid={invalid}
      aria-describedby={hintId} onChange={(event) => { setHeight(event.currentTarget.value) }} /></label>
    <Button size="sm" variant="outline" type="submit">{t('apply')}</Button>
    <p id={hintId} className={css.hint} role={invalid ? 'alert' : undefined}>{t(invalid ? 'size.invalid' : 'size.bounds', bounds)}</p>
  </form>
}

function ImageSelection(props: DeviceControlsProps): ReactNode {
  const { t, view, actions, tabId, lane } = props
  const inputRef = useRef<HTMLInputElement>(null)
  const readerRef = useRef<FileReader | null>(null)
  const [failed, setFailed] = useState(false)
  useEffect(() => () => { readerRef.current?.abort() }, [])
  const selectImage = (file: File | undefined): void => {
    readerRef.current?.abort()
    if (file === undefined) return
    if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(file.type)) { setFailed(true); return }
    setFailed(false)
    const orientation = view.orientation
    const reader = new FileReader()
    readerRef.current = reader
    reader.onerror = () => { setFailed(true) }
    reader.onload = () => {
      if (typeof reader.result === 'string') actions.setImage(tabId, lane, orientation, { name: file.name, src: reader.result })
      else setFailed(true)
    }
    reader.readAsDataURL(file)
  }
  return <div className={css.imageActions}>
    <input ref={inputRef} className={css.fileInput} type="file" accept="image/png,image/jpeg,image/webp,image/gif"
      aria-label={t('image.select', { orientation: t(view.orientation) })}
      onChange={(event) => { selectImage(event.currentTarget.files?.[0]); event.currentTarget.value = '' }} />
    <Button size="sm" variant="outline" onClick={() => { inputRef.current?.click() }}>{t('image.select', { orientation: t(view.orientation) })}</Button>
    {view.images[view.orientation] !== undefined && <Button size="sm" variant="ghost"
      onClick={() => { actions.setImage(tabId, lane, view.orientation, undefined) }}>{t('image.remove')}</Button>}
    {failed && <p className={css.hint} role="alert">{t('image.failed')}</p>}
  </div>
}

/**
 * Render hardware, orientation, size, zoom and explicit image selection controls.
 * @param props - lane choices and declared store mutations.
 * @returns the lane's control rows.
 */
export function DeviceControls(props: DeviceControlsProps): ReactNode {
  const { t, view, actions, tabId, lane } = props
  const [menuOpen, setMenuOpen] = useState(false)
  const [customOpen, setCustomOpen] = useState(view.sizing === 'custom')
  const kinds: readonly DeviceKind[] = lane === 'phone' ? ['ios-phone', 'android-phone'] : ['ios-tablet', 'android-tablet']
  return <div className={css.controls}>
    <div className={css.controlRow}>
      <Menu open={menuOpen} portal selectedId={view.kind} onClose={() => { setMenuOpen(false) }}
        anchor={<Button size="sm" variant="outline" aria-label={t('device')} aria-expanded={menuOpen} aria-haspopup="menu"
          onClick={() => { setMenuOpen(!menuOpen) }}>{t(`device.${view.kind}`)}<IconChevronDownOutlineRegular size={14} /></Button>}
        items={kinds.map(kind => ({ id: kind, label: t(`device.${kind}`) }))}
        onSelect={(kind) => {
          const selected = kinds.find(candidate => candidate === kind)
          if (selected !== undefined) actions.setKind(tabId, lane, selected)
          setMenuOpen(false)
        }} />
      <div className={css.choiceGroup} role="group" aria-label={t('orientation')}>
        {(['portrait', 'landscape'] as const).map(orientation => <Button key={orientation} size="sm" variant="ghost"
          aria-pressed={view.orientation === orientation}
          onClick={() => { actions.setOrientation(tabId, lane, orientation) }}>{t(orientation)}</Button>)}
      </div>
    </div>
    <div className={css.controlRow}>
      <Button size="sm" variant="ghost" aria-pressed={!customOpen}
        onClick={() => { actions.setPreset(tabId, lane); setCustomOpen(false) }}>{t('preset')}</Button>
      <Button size="sm" variant="ghost" aria-pressed={customOpen} onClick={() => { setCustomOpen(true) }}>{t('custom')}</Button>
      <div className={css.choiceGroup} role="group" aria-label={t('scale')}>
        <Button size="sm" variant="ghost" aria-pressed={view.zoom === 'fit'} onClick={() => { actions.setZoom(tabId, lane, 'fit') }}>{t('fit')}</Button>
        <Button size="sm" variant="ghost" aria-pressed={view.zoom === 'actual'} onClick={() => { actions.setZoom(tabId, lane, 'actual') }}>{t('actual')}</Button>
      </div>
    </div>
    {customOpen && <CustomSize key={`${view.orientation}:${view.dimensions.width}:${view.dimensions.height}`} {...props} />}
    <div className={css.choiceGroup} role="group" aria-label={t('source')}>
      <Button size="sm" variant="ghost" disabled={!props.liveAvailable} aria-pressed={props.liveAvailable && view.source === 'live'}
        onClick={() => { actions.setSource(tabId, lane, 'live') }}>{t('live')}</Button>
      <Button size="sm" variant="ghost" aria-pressed={!props.liveAvailable || view.source === 'image'}
        onClick={() => { actions.setSource(tabId, lane, 'image') }}>{t('image')}</Button>
    </div>
    {(!props.liveAvailable || view.source === 'image') && <ImageSelection {...props} />}
  </div>
}
