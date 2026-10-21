/** Flat CSS screen inside scaled hardware chrome; mounting does not own browser lifetime. */
import { useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import clsx from 'clsx'
import { StateDot, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TabId } from '@deepseek-ai/dsh-client-ui-dockkit'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { DevicePreviewInjected, DeviceSurfaceState } from './model.ts'
import type { DeviceLaneView } from './store.ts'
import type {} from './copy.ts'
import { deviceBezel, fitDeviceScale, orientedViewport, type DeviceLane, type DeviceViewport } from './viewport.ts'
import { RESIZE_DIRECTIONS, resizeOrigin } from './device-resize.ts'
import { useDeviceResize } from './use-device-resize.ts'
import css from './DevicePreview.module.css'
import resizeCss from './DeviceResize.module.css'

/** Plain presentation inputs; the parent component supplies localized copy and declared-store actions. */
export interface DeviceFrameProps extends PropsLocale<'devicePreview'> {
  readonly tabId: TabId
  readonly lane: DeviceLane
  readonly view: DeviceLaneView
  readonly live: boolean
  readonly visible: boolean
  readonly surface: DeviceSurfaceState | undefined
  readonly mountSurface: DevicePreviewInjected['mountSurface']
  readonly updateSurface: DevicePreviewInjected['updateSurface']
  readonly publishScale: (scale: number) => void
  /** Apply bounded integer CSS dimensions in the displayed orientation; cancellations retain the latest size. */
  readonly resizeViewport: (viewport: DeviceViewport) => void
}

/**
 * Render chrome without perspective transforms on the screen or screenshot.
 * @param props - dimensions, adapter attachment and localized labels.
 * @returns frame and visible CSS dimensions/display scale.
 */
export function DeviceFrame(props: DeviceFrameProps): ReactNode {
  const { view, t } = props
  const panelRef = useRef<HTMLDivElement>(null)
  const hostRef = useRef<HTMLDivElement>(null)
  const frameRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const [panel, setPanel] = useState<DeviceViewport>({ width: 0, height: 0 })
  const [failedAsset, setFailedAsset] = useState<string>()
  const viewport = orientedViewport(view.dimensions, view.orientation)
  const bezel = deviceBezel(view.kind)
  const fittedScale = view.zoom === 'actual' ? 1 : fitDeviceScale({ width: panel.width - 16, height: panel.height - 16 }, viewport, bezel)
  const resize = useDeviceResize({ viewport, scale: fittedScale, visible: props.visible,
    presentation: `${view.kind}/${view.orientation}/${view.zoom}/${view.source}`,
    frame: frameRef, scroll: scrollRef, resizeViewport: props.resizeViewport })
  const drag = props.visible ? resize.drag : undefined
  const scale = drag?.scale ?? fittedScale
  const origin = drag === undefined ? undefined : resizeOrigin(drag.viewport, viewport, drag.direction, drag.scale)
  const displayLive = props.live && view.source === 'live'
  const image = view.images[view.orientation]
  const imageFailed = image !== undefined && failedAsset === image.src

  useLayoutEffect(() => {
    const host = panelRef.current
    if (host === null) return
    const observer = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect
      if (rect !== undefined) setPanel({ width: rect.width, height: rect.height })
    })
    observer.observe(host)
    return () => { observer.disconnect() }
  }, [])
  useLayoutEffect(() => { props.publishScale(scale) }, [props.publishScale, scale])
  const geometryRef = useRef({ ...viewport, scale: scale || 1 })
  geometryRef.current = { ...viewport, scale: scale || 1 }
  useLayoutEffect(() => {
    const host = hostRef.current
    if (!props.live || host === null) return
    return props.mountSurface(props.tabId, props.lane, host, geometryRef.current)
  }, [props.mountSurface, props.tabId, props.lane, props.live])
  useLayoutEffect(() => {
    if (!props.live) return
    props.updateSurface(props.tabId, props.lane, { ...viewport, scale: scale || 1 }, displayLive && props.visible && scale > 0)
  }, [props.updateSurface, props.tabId, props.lane, props.live, displayLive, props.visible, viewport.width, viewport.height, scale])

  const variables = {
    '--device-width': `${viewport.width}px`, '--device-height': `${viewport.height}px`,
    '--device-bezel': `${bezel}px`, '--device-scale': String(scale),
    '--device-display-width': `${(viewport.width + bezel * 2) * scale}px`,
    '--device-display-height': `${(viewport.height + bezel * 2) * scale}px`,
    '--device-resize-left': `${(drag?.left ?? 0) + (origin?.left ?? 0)}px`,
    '--device-resize-top': `${(drag?.top ?? 0) + (origin?.top ?? 0)}px`,
  } as CSSProperties
  const scrollVariables = drag === undefined ? undefined : {
    '--device-resize-scroll-width': `${drag.scrollWidth}px`, '--device-resize-scroll-height': `${drag.scrollHeight}px`,
  } as CSSProperties
  const resizeLabels = { n: t('resize.n'), ne: t('resize.ne'), e: t('resize.e'), se: t('resize.se'),
    s: t('resize.s'), sw: t('resize.sw'), w: t('resize.w'), nw: t('resize.nw') }
  return <div className={css.frameArea}>
    <div className={css.fitPanel} ref={panelRef}>
      <div className={clsx(css.scrollPanel, resizeCss.scroll, drag !== undefined && resizeCss.dragScroll)}
        ref={scrollRef} style={scrollVariables}>
        <div className={clsx(css.scaledSize, resizeCss.frame, drag !== undefined && resizeCss.dragging)} style={variables} ref={frameRef}>
          <div className={clsx(css.hardware, css[view.kind], view.orientation === 'landscape' && css.landscape)}>
            <span className={css.hardwareButtons} aria-hidden="true" />
            <span className={css.camera} aria-hidden="true" />
            <div className={css.screen} aria-busy={displayLive && props.surface?.phase === 'loading'}>
              {props.live && <div className={css.surface} ref={hostRef} hidden={!displayLive} aria-label={t(`device.${view.kind}`)} />}
              {displayLive ? <>
                {(props.surface === undefined || props.surface.phase === 'idle') && <p className={css.screenNotice}>{t('empty')}</p>}
                {props.surface?.phase === 'loading' && <div className={css.screenNotice} role="status" aria-label={t('loading')}><StateDot state="ongoing" /></div>}
              </> : image !== undefined && !imageFailed
                ? <img className={css.screenshot} src={image.src} draggable={false}
                  alt={t('image.alt', { name: image.name, orientation: t(view.orientation) })}
                  onError={() => { setFailedAsset(image.src) }} />
                : <p className={css.screenNotice}>{t(imageFailed ? 'image.failed' : 'image.missing', { orientation: t(view.orientation) })}</p>}
            </div>
          </div>
          {RESIZE_DIRECTIONS.map(direction => <Tooltip key={direction} label={t('resize.hint')} portal disabled={!props.visible || drag !== undefined}>
            <button type="button" className={clsx(resizeCss.handle, resizeCss[direction])}
              aria-label={resizeLabels[direction]} disabled={!props.visible || scale <= 0}
              onPointerDown={(event) => { resize.begin(direction, event) }}
              onKeyDown={(event) => { resize.keyboard(direction, event) }} />
          </Tooltip>)}
        </div>
      </div>
    </div>
    {drag !== undefined && createPortal(<div className={clsx(resizeCss.shield, resizeCss[drag.direction])} aria-hidden="true" />, document.body)}
    <output className={css.dimensions} aria-label={t('scale')} aria-live="polite" aria-atomic="true">{t('dimensions', {
      width: String(viewport.width), height: String(viewport.height), percent: String(Math.round(scale * 100)),
    })}</output>
    {!displayLive && <p className={css.imageLabel}>{t('image.label')}</p>}
  </div>
}
