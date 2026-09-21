import { useEffect, useRef, useState } from 'react'
import type { CSSProperties, RefObject } from 'react'
import { createPortal } from 'react-dom'
import type { McpServerView } from '@deepseek-ai/dsh-api-remotes/client'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { InjectFace, PropsLocale, PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import {
  Tooltip, useAnchoredPosition, useDismissOnOutsidePointer,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { createAccountsMenuStore } from './accounts-menu-store.ts'
import { mcpActivity, type McpActivityChatSnapshot, type McpActivityRecord } from './mcp-activity.ts'
import type { McpStatusSnapshot } from './mcp-status.ts'
import css from './McpSessionStatus.module.css'

const MEASURE_STYLE = { left: 0, top: 0, visibility: 'hidden' as const }

/** MCP health supplied to the Session header action. */
export interface McpSessionStatusInjected {
  readonly hooks: { readonly mcpStatus: ObservableSnapshot<McpStatusSnapshot> }
  readonly reconnect: (serverId: string) => Promise<string | undefined>
}

/** Full props for the Session header MCP status action. */
export type McpSessionStatusProps = PropsRuntime<'conversation.session.header.actions'>
  & PropsLocale<'customHarnessBrand'>
  & PropsStore<ReturnType<typeof createAccountsMenuStore>>
  & InjectFace<McpSessionStatusInjected>

type OverallStatus = 'empty' | 'disabled' | 'connected' | 'connecting' | 'error'

function McpIcon() {
  return (
    <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor"
      strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="4" cy="4" r="1.7" /><circle cx="12" cy="4" r="1.7" /><circle cx="8" cy="12" r="1.7" />
      <path d="m5.4 5 1.7 5M10.6 5 8.9 10M5.7 4h4.6" />
    </svg>
  )
}

function overallStatus(servers: readonly McpServerView[]): OverallStatus {
  if (servers.length === 0) return 'empty'
  if (servers.every(server => !server.enabled || server.status === 'disabled')) return 'disabled'
  if (servers.some(server => server.status === 'error')) return 'error'
  if (servers.some(server => server.status === 'connecting' || server.status === 'reconnecting')) return 'connecting'
  return 'connected'
}

function serverRank(server: McpServerView, activeIds: ReadonlySet<string>): number {
  if (activeIds.has(server.id)) return 0
  if (server.status === 'error') return 1
  if (server.status === 'connecting' || server.status === 'reconnecting') return 2
  if (server.status === 'connected') return 3
  return 4
}

function statusCopy(server: McpServerView, t: McpSessionStatusProps['t']): string {
  const key = {
    disabled: 'mcpStatusDisabled',
    connecting: 'mcpStatusConnecting',
    connected: 'mcpStatusConnected',
    reconnecting: 'mcpStatusReconnecting',
    error: 'mcpStatusError',
  } as const
  return t(key[server.status])
}

function summaryCopy(status: OverallStatus, servers: readonly McpServerView[], t: McpSessionStatusProps['t']): string {
  if (status === 'empty') return t('mcpSessionNoServers')
  if (status === 'disabled') return t('mcpSessionAllDisabled')
  const key = status === 'error'
    ? 'mcpSessionNeedsAttention'
    : status === 'connecting'
      ? 'mcpSessionConnecting'
      : 'mcpSessionConnected'
  const count = status === 'error'
    ? servers.filter(server => server.status === 'error').length
    : status === 'connecting'
      ? servers.filter(server => server.status === 'connecting' || server.status === 'reconnecting').length
      : servers.filter(server => server.status === 'connected').length
  return t(key, { count: String(count) })
}

function activityStatus(record: McpActivityRecord, t: McpSessionStatusProps['t']): string {
  return t(record.status === 'running'
    ? 'mcpSessionRunning'
    : record.status === 'success'
      ? 'mcpSessionSucceeded'
      : 'mcpSessionFailed')
}

function activityTime(timestamp: number): string {
  return new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(timestamp)
}

function McpPanel({ panelRef, position, servers, activity, reconnecting, reconnect, manage, viewCall, t }: {
  readonly panelRef: RefObject<HTMLDivElement>
  readonly position: CSSProperties | null
  readonly servers: readonly McpServerView[]
  readonly activity: readonly McpActivityRecord[]
  readonly reconnecting: ReadonlySet<string>
  readonly reconnect: (serverId: string) => void
  readonly manage: () => void
  readonly viewCall: (callId: string) => void
  readonly t: McpSessionStatusProps['t']
}) {
  const activeIds = new Set(activity.filter(record => record.status === 'running').map(record => record.serverId))
  const sorted = [...servers].sort((left, right) => serverRank(left, activeIds) - serverRank(right, activeIds))
  return createPortal((
    <div ref={panelRef} className={css.panel} style={position ?? MEASURE_STYLE}
      role="dialog" aria-label={t('mcpSessionTitle')}>
      <div className={css.panelHeader}>
        <div><strong>{t('mcpSessionTitle')}</strong><span>{summaryCopy(overallStatus(servers), servers, t)}</span></div>
        <button type="button" className={css.manage} onClick={manage}>{t('mcpSessionManage')}</button>
      </div>
      <div className={css.servers}>
        {sorted.length === 0
          ? <p className={css.empty}>{t('mcpSessionNoServers')}</p>
          : sorted.map((server) => {
            const latest = activity.find(record => record.serverId === server.id)
            return (
              <div key={server.id} className={css.server} data-status={server.status}>
                <span className={css.statusDot} aria-hidden="true" />
                <span className={css.serverBody}>
                  <strong>{server.name}</strong>
                  <span>{statusCopy(server, t)}</span>
                  <span>{latest === undefined
                    ? t('mcpSessionNeverUsed')
                    : t('mcpSessionLastUsed', { time: activityTime(latest.finishedAt ?? latest.startedAt) })}</span>
                </span>
                {server.status === 'error' && (
                  <button type="button" className={css.reconnect} disabled={reconnecting.has(server.id)}
                    onClick={() => { reconnect(server.id) }}>
                    {reconnecting.has(server.id) ? t('mcpStatusReconnecting') : t('mcpSessionReconnect')}
                  </button>
                )}
              </div>
            )
          })}
      </div>
      <div className={css.activityHeader}>{t('mcpSessionRecentActivity')}</div>
      <div className={css.activity}>
        {activity.length === 0
          ? <p className={css.empty}>{t('mcpSessionNoActivity')}</p>
          : activity.map(record => (
            <div key={record.callId} className={css.activityRow} data-status={record.status}>
              <span className={css.activityDot} aria-hidden="true" />
              <span className={css.activityBody}>
                <strong title={t('mcpSessionTechnicalName', { name: record.technicalName })}>{record.toolName}</strong>
                <span>{activityStatus(record, t)} · {activityTime(record.finishedAt ?? record.startedAt)}</span>
                {record.status === 'error' && <span>{t('mcpSessionSafeFailure')}</span>}
              </span>
              {record.status === 'error' && (
                <button type="button" className={css.viewCall} onClick={() => { viewCall(record.callId) }}>
                  {t('mcpSessionViewCall')}
                </button>
              )}
            </div>
          ))}
      </div>
    </div>
  ), document.body)
}

/** Render global MCP health and current-Session MCP activity in the title bar. */
export function McpSessionStatus({
  useMcpStatus, useConversation, actions, reconnect, openConversationEvent, t,
}: McpSessionStatusProps) {
  const snapshot = useMcpStatus(value => value)
  const conversation = useConversation(value => value)
  const servers = snapshot.state?.servers ?? []
  const chat = (conversation as unknown as {
    readonly views: { readonly get: (id: string) => unknown }
  } | undefined)?.views.get('chat') as McpActivityChatSnapshot | undefined
  // Conversation views may preserve their outer identity while their legacy
  // tool-call projection advances, so derive activity on every published render.
  const activity = mcpActivity(chat, servers)
  const status = overallStatus(servers)
  const running = activity.filter(record => record.status === 'running').length
  const [open, setOpen] = useState(false)
  const [reconnecting, setReconnecting] = useState<ReadonlySet<string>>(new Set())
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const position = useAnchoredPosition({ open, anchorRef: triggerRef, panelRef, gap: 6, margin: 12 })
  useDismissOnOutsidePointer(rootRef, open, setOpen, panelRef)

  useEffect(() => {
    if (!open) return
    const close = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      setOpen(false)
      triggerRef.current?.focus()
    }
    document.addEventListener('keydown', close)
    return () => { document.removeEventListener('keydown', close) }
  }, [open])

  const reconnectServer = (serverId: string): void => {
    setReconnecting(current => new Set([...current, serverId]))
    void reconnect(serverId).finally(() => {
      setReconnecting((current) => {
        const next = new Set(current)
        next.delete(serverId)
        return next
      })
    })
  }

  const manage = (): void => {
    setOpen(false)
    actions.requestSection('custom-harness-mcp')
  }

  return (
    <div ref={rootRef} className={css.root}>
      <Tooltip label={t('mcpSessionOpen')} side="bottom" delayMs={500} disabled={open}>
        <button ref={triggerRef} type="button" className={css.trigger} data-status={status}
          aria-label={`${t('mcpSessionOpen')}: ${summaryCopy(status, servers, t)}`}
          aria-haspopup="dialog" aria-expanded={open} onClick={() => { setOpen(current => !current) }}>
          <McpIcon />
          <span className={css.triggerLabel}>{t('mcpSessionShortLabel')}</span>
          {running > 0 && <span className={css.runningCount} aria-hidden="true">{running}</span>}
          <span className={css.triggerDot} aria-hidden="true" />
        </button>
      </Tooltip>
      {open && <McpPanel panelRef={panelRef} position={position} servers={servers} activity={activity}
        reconnecting={reconnecting} reconnect={reconnectServer} manage={manage}
        viewCall={(callId) => { setOpen(false); openConversationEvent(callId) }} t={t} />}
    </div>
  )
}
