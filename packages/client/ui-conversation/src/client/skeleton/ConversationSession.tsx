/** Strict per-session header/body content inserted into the resident conversation layout. */

import clsx from 'clsx'
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { IconEllipsisOutlineRegular, MenuSurface, observeComposition, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SessionListState, SessionSummary } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {
  ConversationSessionHeaderSlotProps, ConversationSessionSlotProps,
} from '../contract/slots.ts'
import { resolveActiveView } from '../view-selection.ts'
import { DefaultConversationViews } from './DefaultConversationViews.tsx'
import css from './ConversationRoot.module.css'

/** Full props composed from the strict session body contract. */
export type ConversationSessionProps = ConversationSessionSlotProps

/** Full props composed from the strict session header contract. */
export type ConversationSessionHeaderProps = ConversationSessionHeaderSlotProps

interface Breadcrumb {
  readonly id: SessionId
  readonly displayTitle: string
  readonly subagent: boolean
}

function deriveAncestry(list: SessionListState, id: SessionId): readonly Breadcrumb[] {
  const chain: Breadcrumb[] = []
  const seen = new Set<SessionId>()
  let cursor: SessionId | undefined = id
  while (cursor !== undefined) {
    if (seen.has(cursor)) break
    seen.add(cursor)
    const summary: SessionSummary | undefined = list.byId[cursor]
    if (summary === undefined) break
    chain.unshift({
      id: summary.id,
      displayTitle: summary.displayTitle,
      subagent: summary.origin === 'subagent',
    })
    if (summary.origin !== 'subagent') break
    cursor = summary.parentId
  }
  return chain
}

function equalBreadcrumbs(left: readonly Breadcrumb[], right: readonly Breadcrumb[]): boolean {
  return left.length === right.length
    && left.every((item, index) => {
      const other = right.at(index)
      return other !== undefined && item.id === other.id && item.displayTitle === other.displayTitle
    })
}

function expandedUtilityButton(controls: HTMLElement | null): HTMLButtonElement | null {
  return controls?.querySelector<HTMLButtonElement>('button[aria-expanded="true"]') ?? null
}

/**
 * Renders Session header chrome above the resident conversation scrollport.
 * Secondary utilities remain mounted across inline/overflow width changes.
 * @param props - Strict Session store, view ledger, navigation, render, and locale shares.
 * @returns Session navigation controls, with title and tabs after conversation starts.
 */
export function ConversationSessionHeader({
  sessionId, hideChrome, useSessions, useConversationViews, useStore,
  renderSlot, open, selectView, openView, t,
}: ConversationSessionHeaderProps) {
  const tabs = useConversationViews(value => value)
  const selectedId = useStore(s => s.view)
  const active = resolveActiveView(tabs, selectedId)
  const ancestry = useSessions(s => deriveAncestry(s, sessionId), equalBreadcrumbs)
  const showTabs = !hideChrome && tabs.length > 1
  const rowRef = useRef<HTMLDivElement>(null)
  const utilitiesRef = useRef<HTMLDivElement>(null)
  const controlsRef = useRef<HTMLDivElement>(null)
  const moreRef = useRef<HTMLButtonElement>(null)
  const insidePointer = useRef<Event | null>(null)
  const focusUtilities = useRef(false)
  const utilitiesId = useId()
  const [compactUtilities, setCompactUtilities] = useState(false)
  const [utilitiesOpen, setUtilitiesOpen] = useState(false)

  useLayoutEffect(() => {
    if (hideChrome) {
      setUtilitiesOpen(false)
      return
    }
    const measure = (): void => {
      const trigger = moreRef.current
      if (trigger === null) return
      const compact = getComputedStyle(trigger).display !== 'none'
      setCompactUtilities(compact)
      setUtilitiesOpen(current => compact && (current
        || controlsRef.current?.contains(document.activeElement) === true
        || expandedUtilityButton(controlsRef.current) !== null))
    }
    const observer = new ResizeObserver(measure)
    if (rowRef.current !== null) observer.observe(rowRef.current)
    measure()
    return () => { observer.disconnect() }
  }, [hideChrome])

  useEffect(() => {
    if (!utilitiesOpen) return
    if (focusUtilities.current) {
      controlsRef.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus()
      focusUtilities.current = false
    }
    const composition = observeComposition(document)
    const outside = (event: PointerEvent): void => {
      if (insidePointer.current !== event && event.target instanceof Node
        && utilitiesRef.current?.contains(event.target) !== true) setUtilitiesOpen(false)
    }
    const escape = (event: KeyboardEvent): void => {
      if (composition.guards(event) || event.repeat || event.key !== 'Escape') return
      // Nested menus get the first chance to consume Escape, including portals.
      queueMicrotask(() => {
        if (event.defaultPrevented) return
        const nested = expandedUtilityButton(controlsRef.current)
        if (nested !== null) {
          nested.focus()
          nested.click()
          return
        }
        setUtilitiesOpen(false)
        moreRef.current?.focus()
      })
    }
    document.addEventListener('pointerdown', outside)
    document.addEventListener('keydown', escape)
    return () => {
      document.removeEventListener('pointerdown', outside)
      document.removeEventListener('keydown', escape)
      composition.dispose()
    }
  }, [utilitiesOpen])

  const openUtilities = (): void => {
    if (utilitiesOpen) expandedUtilityButton(controlsRef.current)?.click()
    focusUtilities.current = !utilitiesOpen
    setUtilitiesOpen(current => !current)
  }

  return (
    <>
      <div ref={rowRef} className={css.titleRow}>
        {!hideChrome && (
          <>
            <div className={css.titleCluster}>
              <nav className={css.crumbs} aria-label={t('session.hierarchy')}>
                {ancestry.map((summary, index) => {
                  const last = index === ancestry.length - 1
                  // The current crumb has no navigation, so it is plain text
                  // rather than a disabled button: on darwin desktop a button
                  // would subtract itself from the header's drag row (ui-web
                  // base.css) and leave the title inert for dragging too.
                  const title = last
                    ? (
                      <span className={clsx(css.crumb, summary.subagent && css.crumbSubagent, css.crumbCurrent)}>
                        {summary.displayTitle}
                      </span>
                    )
                    : (
                      <button
                        type="button"
                        className={clsx(css.crumb, summary.subagent && css.crumbSubagent)}
                        onClick={() => { open(summary.id) }}
                      >
                        {summary.displayTitle}
                      </button>
                    )
                  const lineage = last || summary.subagent
                  const lineageOwner = {
                    lineageSessionId: summary.id,
                    displayTitle: summary.displayTitle,
                    ...last ? {} : { openTitle: () => { open(summary.id) } },
                  }
                  return (
                    <span key={summary.id} className={css.crumbSeg}>
                      {index > 0 && <span className={css.crumbSep}>/</span>}
                      {lineage
                        ? summary.subagent
                          ? renderSlot(
                            'conversation.session.header.lineage',
                            lineageOwner,
                            { fallback: title },
                          )
                          : (
                            <>
                              {title}
                              {renderSlot(
                                'conversation.session.header.lineage',
                                lineageOwner,
                                { fallback: null },
                              )}
                            </>
                          )
                        : title}
                    </span>
                  )
                })}
                {ancestry.length === 0 && <span className={css.crumbCurrent}>{sessionId}</span>}
              </nav>
              <div className={css.headerActions}>
                {renderSlot('conversation.session.header.actions', {
                  openConversationEvent: (callId) => { openView('chat', `call:${callId}`) },
                })}
              </div>
            </div>
            <div ref={utilitiesRef} className={css.headerUtilities}
              onPointerDownCapture={(event) => { insidePointer.current = event.nativeEvent }}>
              <Tooltip label={t('header.moreControls')} side="bottom" portal disabled={utilitiesOpen}>
                <button ref={moreRef} type="button" className={css.utilitiesMore}
                  aria-label={t('header.moreControls')} aria-expanded={utilitiesOpen}
                  aria-controls={utilitiesId} onClick={openUtilities}>
                  <IconEllipsisOutlineRegular size={16} />
                </button>
              </Tooltip>
              <div ref={controlsRef} id={utilitiesId} className={css.headerUtilitiesControls}
                role="group" aria-label={t('header.controls')} data-open={utilitiesOpen}>
                {compactUtilities && utilitiesOpen && <MenuSurface compact aria-hidden="true" className={css.utilitiesMaterial} />}
                {renderSlot('conversation.session.header.utilities', {
                  openConversationEvent: (callId) => { openView('chat', `call:${callId}`) },
                })}
              </div>
            </div>
          </>
        )}
        <div className={css.headerCorner} data-conversation-header-corner="">
          {renderSlot('conversation.session.header.corner', {})}
        </div>
      </div>
      {showTabs && (
        // data-conversation-tabs: marks the tab strip, which the window-chrome
        // geometry and the browser coverage lane anchor on.
        <div className={css.tabs} role="tablist" data-conversation-tabs="">
          {tabs.map(viewTab => (
            <button
              key={viewTab.id}
              type="button"
              role="tab"
              aria-selected={viewTab.id === active?.id}
              className={clsx(css.tab, viewTab.id === active?.id && css.tabActive)}
              onClick={() => { selectView(viewTab.id) }}
            >
              {viewTab.label}
            </button>
          ))}
        </div>
      )}
    </>
  )
}

/**
 * Renders the active Session view inside the resident scrollport and keeps
 * the input draft mirrored while blank Hero chrome is visible.
 * @param props - Strict Session input/store, view ledger, and render shares.
 * @returns the active view area, or null while the Session remains blank.
 */
export function ConversationSession(props: ConversationSessionProps) {
  return <DefaultConversationViews {...props} />
}
