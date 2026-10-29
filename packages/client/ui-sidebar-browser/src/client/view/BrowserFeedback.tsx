/** Human-authored browser feedback captured into the current chat draft. */
import { useEffect, useRef, useState, type PointerEvent, type ReactNode } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-locale/client'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { BrowserAnnotationCapture, BrowserPickedElement } from '../../types.ts'
import { annotatedBrowserFile, annotationHit, annotationRect, type AnnotationPoint, type BrowserAnnotation } from './browser-annotations.ts'
import css from './Browser.module.css'

type AnnotationTool = 'select' | 'region' | 'draw' | 'erase'
const TOOLS = ['select', 'region', 'draw', 'erase'] as const

/** Browser feedback has no agent action: it stages a screenshot and context for human review. */
export function BrowserFeedback({ capture, pick, addFeedback, t }: {
  readonly capture: () => Promise<BrowserAnnotationCapture>
  readonly pick: (point: AnnotationPoint) => Promise<BrowserPickedElement | null>
  readonly addFeedback: (file: File, text: string) => boolean
  readonly t: TranslateNS<'sidebarBrowser'>
}): ReactNode {
  const [shot, setShot] = useState<BrowserAnnotationCapture>()
  const [tool, setTool] = useState<AnnotationTool>('select')
  const [annotations, setAnnotations] = useState<readonly BrowserAnnotation[]>([])
  const [pending, setPending] = useState<BrowserAnnotation>()
  const [comment, setComment] = useState('')
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const gesture = useRef<AnnotationPoint>()
  const generation = useRef(0)
  useEffect(() => () => { generation.current++ }, [])
  const close = (): void => {
    generation.current++
    gesture.current = undefined
    setBusy(false)
    setShot(undefined)
    setAnnotations([])
    setPending(undefined)
    setComment('')
  }
  const start = (next: AnnotationTool): void => {
    setTool(next)
    setBusy(true)
    setFailed(false)
    const epoch = ++generation.current
    void capture().then((value) => { if (epoch === generation.current) setShot(value) })
      .catch(() => { if (epoch === generation.current) setFailed(true) })
      .finally(() => { if (epoch === generation.current) setBusy(false) })
  }
  const pointOf = (event: PointerEvent<SVGSVGElement>, screenshot: BrowserAnnotationCapture): AnnotationPoint => {
    const bounds = event.currentTarget.getBoundingClientRect()
    return { x: Math.max(0, Math.min(screenshot.width, (event.clientX - bounds.left) * screenshot.width / bounds.width)),
      y: Math.max(0, Math.min(screenshot.height, (event.clientY - bounds.top) * screenshot.height / bounds.height)) }
  }
  const begin = (event: PointerEvent<SVGSVGElement>): void => {
    if (busy || shot === undefined || event.button !== 0) return
    const point = pointOf(event, shot)
    if (tool === 'erase') { setAnnotations(current => current.filter(shape => !annotationHit(shape, point))); return }
    if (tool === 'select') {
      const epoch = generation.current
      setBusy(true)
      setFailed(false)
      void pick({ x: point.x * shot.viewportWidth / shot.width, y: point.y * shot.viewportHeight / shot.height }).then((element) => {
        if (epoch === generation.current && element !== null) setAnnotations(current => [...current, { kind: 'element', ...element, rect: {
          x: element.rect.x * shot.width / shot.viewportWidth, y: element.rect.y * shot.height / shot.viewportHeight,
          width: element.rect.width * shot.width / shot.viewportWidth, height: element.rect.height * shot.height / shot.viewportHeight } }])
      }).catch(() => { if (epoch === generation.current) setFailed(true) })
        .finally(() => { if (epoch === generation.current) setBusy(false) })
      return
    }
    gesture.current = point
    event.currentTarget.setPointerCapture(event.pointerId)
    setPending(tool === 'draw' ? { kind: 'stroke', points: [point] } : { kind: 'region', rect: annotationRect(point, point) })
  }
  const move = (event: PointerEvent<SVGSVGElement>): void => {
    if (gesture.current === undefined || shot === undefined) return
    const point = pointOf(event, shot)
    const first = gesture.current
    setPending(current => current?.kind === 'stroke' ? { kind: 'stroke', points: [...current.points, point] }
      : { kind: 'region', rect: annotationRect(first, point) })
  }
  const finish = (): void => {
    if (gesture.current === undefined) return
    gesture.current = undefined
    if (pending !== undefined) setAnnotations(current => [...current, pending])
    setPending(undefined)
  }
  const submit = (): void => {
    if (shot === undefined || busy) return
    setBusy(true)
    setFailed(false)
    const epoch = generation.current
    const context = [shot.title, shot.url, comment, ...annotations.flatMap(shape => shape.kind === 'element'
      ? [`${shape.tagName} ${shape.selector}\n${shape.text}`] : shape.kind === 'region' ? [`Region: ${JSON.stringify(shape.rect)}`] : [])]
      .filter(Boolean).join('\n\n')
    void annotatedBrowserFile(shot.png, annotations).then((file) => {
      if (epoch !== generation.current) return
      if (addFeedback(file, context)) close()
      else setFailed(true)
    }).catch((error: unknown) => {
      console.error('Browser feedback could not be staged', error)
      if (epoch === generation.current) setFailed(true)
    })
      .finally(() => { if (epoch === generation.current) setBusy(false) })
  }
  return <>
    <div className={css.feedbackTools} role="group" aria-label={t('annotation.tools')}>
      {TOOLS.map(next => <button type="button" className={css.annotationTool} key={next} disabled={busy}
        onClick={() => { start(next) }}>{t(`annotation.${next}`)}</button>)}
    </div>
    {failed && shot === undefined && <span role="alert" className={css.feedbackFailure}>{t('annotation.failed')}</span>}
    {shot !== undefined && <Modal open onClose={close} closeLabel={t('close')} title={t('annotation.title')}
      footer={<><Button variant="outline" onClick={close}>{t('cancel')}</Button>
        <Button variant="primary" disabled={busy} onClick={submit}>{t('annotation.add')}</Button></>}>
      <div className={css.annotationToolbar} role="group" aria-label={t('annotation.tools')}>
        {TOOLS.map(next => <button type="button" key={next} className={css.annotationTool} aria-pressed={tool === next}
          disabled={busy} onClick={() => { gesture.current = undefined; setPending(undefined); setTool(next) }}>{t(`annotation.${next}`)}</button>)}
        <button type="button" className={css.annotationTool} disabled={busy || annotations.length === 0}
          onClick={() => { setAnnotations(current => current.slice(0, -1)) }}>{t('annotation.undo')}</button>
      </div>
      <div className={css.annotationCanvas} style={{ aspectRatio: `${shot.width} / ${shot.height}` }}>
        <img src={`data:image/png;base64,${shot.png}`} alt={t('annotation.image')} draggable={false} />
        <svg viewBox={`0 0 ${shot.width} ${shot.height}`} aria-label={t('annotation.canvas')}
          onPointerDown={begin} onPointerMove={move} onPointerUp={finish}
          onPointerCancel={() => { gesture.current = undefined; setPending(undefined) }}>
          {[...annotations, ...(pending === undefined ? [] : [pending])].map((shape, index) => shape.kind === 'stroke'
            ? <polyline key={index} points={shape.points.map(point => `${point.x},${point.y}`).join(' ')} fill="none" />
            : <rect key={index} {...shape.rect} />)}
        </svg>
      </div>
      <textarea className={css.annotationComment} aria-label={t('annotation.comment')} placeholder={t('annotation.comment')}
        value={comment} onChange={(event) => { setComment(event.currentTarget.value) }} />
      {failed && <p role="alert">{t('annotation.failed')}</p>}
    </Modal>}
  </>
}
