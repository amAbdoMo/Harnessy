/** Human-authored browser feedback captured into the current chat draft. */
import { useEffect, useRef, useState, type PointerEvent, type ReactNode } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-locale/client'
import { Button, IconCloseOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { BrowserAnnotationCapture, BrowserPickedElement } from '../../types.ts'
import { annotatedBrowserFile, annotationHit, annotationRect, type AnnotationPoint, type BrowserAnnotation } from './browser-annotations.ts'
import css from './Browser.module.css'
import { BrowserAnnotationIcon } from './BrowserAnnotationIcon.tsx'

type AnnotationTool = 'select' | 'region' | 'draw' | 'erase'
const TOOLS = ['select', 'region', 'draw', 'erase'] as const

/** Browser feedback has no agent action: it stages a screenshot and context for human review. */
export function BrowserFeedback({ capture, pick, addFeedback, onClose, t }: {
  readonly capture: () => Promise<BrowserAnnotationCapture>
  readonly pick: (point: AnnotationPoint) => Promise<BrowserPickedElement | null>
  readonly addFeedback: (file: File, text: string) => boolean
  readonly onClose: () => void
  readonly t: TranslateNS<'sidebarBrowser'>
}): ReactNode {
  const [shot, setShot] = useState<BrowserAnnotationCapture>()
  const [tool, setTool] = useState<AnnotationTool>('select')
  const [annotations, setAnnotations] = useState<readonly BrowserAnnotation[]>([])
  const [pending, setPending] = useState<BrowserAnnotation>()
  const [comment, setComment] = useState('')
  const [busy, setBusy] = useState(true)
  const [failed, setFailed] = useState(false)
  const gesture = useRef<AnnotationPoint>()
  const generation = useRef(0)
  const initialCapture = useRef(capture)
  const editor = useRef<HTMLElement>(null)
  useEffect(() => {
    const epoch = ++generation.current
    void initialCapture.current().then((value) => { if (epoch === generation.current) setShot(value) })
      .catch(() => { if (epoch === generation.current) setFailed(true) })
      .finally(() => { if (epoch === generation.current) setBusy(false) })
    editor.current?.focus()
    return () => { generation.current++ }
  }, [])
  const close = (): void => {
    generation.current++
    gesture.current = undefined
    onClose()
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
  return <section ref={editor} className={css.annotationOverlay} aria-label={t('annotation.title')} tabIndex={-1}
    onKeyDown={(event) => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close() } }}>
    {shot !== undefined && <div className={css.annotationCanvas}>
      <img src={`data:image/png;base64,${shot.png}`} alt={t('annotation.image')} draggable={false} />
      <svg viewBox={`0 0 ${shot.width} ${shot.height}`} preserveAspectRatio="none" aria-label={t('annotation.canvas')}
        onPointerDown={begin} onPointerMove={move} onPointerUp={finish}
        onPointerCancel={() => { gesture.current = undefined; setPending(undefined) }}>
        {[...annotations, ...(pending === undefined ? [] : [pending])].map((shape, index) => shape.kind === 'stroke'
          ? <polyline key={index} points={shape.points.map(point => `${point.x},${point.y}`).join(' ')} fill="none" />
          : <rect key={index} {...shape.rect} />)}
      </svg>
    </div>}
    <div className={css.annotationPalette}>
      <div className={css.annotationToolbar} role="group" aria-label={t('annotation.tools')}>
        {TOOLS.map(next => <button type="button" key={next} className={css.tool} aria-pressed={tool === next}
          title={t(`annotation.${next}`)} aria-label={t(`annotation.${next}`)} disabled={busy || shot === undefined}
          onClick={() => { gesture.current = undefined; setPending(undefined); setTool(next) }}>
          <BrowserAnnotationIcon tool={next} /></button>)}
        <span className={css.annotationDivider} />
        <button type="button" className={css.tool} disabled={busy || annotations.length === 0}
          title={t('annotation.undo')} aria-label={t('annotation.undo')}
          onClick={() => { setAnnotations(current => current.slice(0, -1)) }}><BrowserAnnotationIcon tool="undo" /></button>
        <button type="button" className={css.tool} title={t('cancel')} aria-label={t('cancel')}
          onClick={close}><IconCloseOutlineRegular /></button>
      </div>
      {busy && shot === undefined && <p role="status">{t('loading')}</p>}
      {failed && <p role="alert" className={css.feedbackFailure}>{t('annotation.failed')}</p>}
    </div>
    {shot !== undefined && <div className={css.annotationComposer}>
      <textarea className={css.annotationComment} aria-label={t('annotation.comment')} placeholder={t('annotation.comment')}
        disabled={busy}
        value={comment} onChange={(event) => { setComment(event.currentTarget.value) }} />
      <Button variant="primary" size="sm" disabled={busy || pending !== undefined} onClick={submit}>{t('annotation.add')}</Button>
    </div>}
  </section>
}
