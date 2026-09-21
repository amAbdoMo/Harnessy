/** Harnessy's global MCP server settings page. */

import { useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type {
  McpManagerState, McpServerInput, McpServerTransport, McpServerView,
} from '@deepseek-ai/dsh-api-remotes/client'
import { Button, Modal, StateDot, Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { BrandKey } from './locales.ts'
import { parseMcpJson } from './mcp-import.ts'
import type { McpJsonImport } from './mcp-import.ts'
import css from './McpServersSection.module.css'

const MAX_IMPORT_BYTES = 1_000_000
const MAX_SAVED_SERVERS = 64
const WORDPRESS_ARGUMENTS = '-y\n@automattic/mcp-wordpress-remote@latest'
const WORDPRESS_ENVIRONMENT = [
  'WP_API_URL=https://your-site.example/wp-json/mcp/mcp-adapter-default-server',
  'WP_API_USERNAME=your-username',
  'OAUTH_ENABLED=false',
  'WP_API_PASSWORD=your-application-password',
].join('\n')

/** Result returned by a redacted MCP manager operation. */
export interface McpManagerOutcome {
  readonly state?: McpManagerState
  readonly error?: string
}

/** Browser operations bound to the Host-owned protected MCP registry. */
export interface McpManagerOperations {
  readonly describe: () => Promise<McpManagerOutcome>
  readonly save: (input: McpServerInput) => Promise<McpManagerOutcome>
  readonly setEnabled: (serverId: string, enabled: boolean) => Promise<McpManagerOutcome>
  readonly reconnect: (serverId: string) => Promise<McpManagerOutcome>
  readonly remove: (serverId: string) => Promise<McpManagerOutcome>
  readonly openConfigurationFile: () => Promise<{ readonly error?: string }>
}

/** Registration-side data supplied to the MCP settings section. */
export interface McpServersInjected {
  readonly operations: McpManagerOperations
}

/** Complete slot-composed MCP section props. */
export type McpServersSectionProps = PropsRuntime<'settings.section'>
  & PropsLocale<'customHarnessBrand'>
  & InjectFace<McpServersInjected>

interface Draft {
  readonly id?: string
  readonly name: string
  readonly serverName: string
  readonly transport: McpServerTransport
  readonly enabled: boolean
  readonly url: string
  readonly headerName: string
  readonly authorization: string
  readonly command: string
  readonly args: string
  readonly cwd: string
  readonly environment: string
  readonly authenticationConfigured: boolean
  readonly clearAuthentication: boolean
}

function blankDraft(): Draft {
  return {
    name: '', serverName: '', transport: 'streamable-http', enabled: true,
    url: '', headerName: 'Authorization', authorization: '', command: '', args: '', cwd: '',
    environment: '', authenticationConfigured: false, clearAuthentication: false,
  }
}

function editDraft(server: McpServerView): Draft {
  return {
    id: server.id,
    name: server.name,
    serverName: server.serverName,
    transport: server.transport,
    enabled: server.enabled,
    url: server.transport === 'streamable-http' ? server.endpoint : '',
    headerName: server.headerName ?? 'Authorization',
    authorization: '',
    command: server.transport === 'stdio' ? server.endpoint : '',
    args: server.args.join('\n'),
    cwd: server.cwd ?? '',
    environment: '',
    authenticationConfigured: server.authenticationConfigured,
    clearAuthentication: false,
  }
}

function environmentOf(value: string, invalidLine: string): Record<string, string> | undefined {
  if (value.trim() === '') return undefined
  const environment: Record<string, string> = {}
  for (const raw of value.split(/\r?\n/u)) {
    const line = raw.trim()
    if (line === '') continue
    const split = line.indexOf('=')
    if (split < 1) throw new Error(invalidLine)
    environment[line.slice(0, split).trim()] = line.slice(split + 1)
  }
  return environment
}

function inputOf(draft: Draft, invalidLine: string): McpServerInput {
  const common = {
    ...draft.id === undefined ? {} : { id: draft.id },
    name: draft.name,
    serverName: draft.serverName,
    transport: draft.transport,
    enabled: draft.enabled,
    ...draft.clearAuthentication ? { clearAuthentication: true } : {},
  }
  if (draft.transport === 'streamable-http') {
    return {
      ...common,
      transport: draft.transport,
      url: draft.url,
      headerName: draft.headerName,
      ...draft.authorization === '' ? {} : { authorization: draft.authorization },
    }
  }
  const environment = environmentOf(draft.environment, invalidLine)
  return {
    ...common,
    transport: draft.transport,
    command: draft.command,
    args: draft.args.split(/\r?\n/u).map(value => value.trim()).filter(Boolean),
    cwd: draft.cwd,
    ...environment === undefined ? {} : { environment },
  }
}

function dotState(status: McpServerView['status']): 'done' | 'ongoing' | 'error' | 'idle' {
  if (status === 'connected') return 'done'
  if (status === 'connecting' || status === 'reconnecting') return 'ongoing'
  if (status === 'error') return 'error'
  return 'idle'
}

function statusText(status: McpServerView['status'], t: (key: BrandKey) => string): string {
  const keys: Record<McpServerView['status'], BrandKey> = {
    disabled: 'mcpStatusDisabled',
    connecting: 'mcpStatusConnecting',
    connected: 'mcpStatusConnected',
    reconnecting: 'mcpStatusReconnecting',
    error: 'mcpStatusError',
  }
  return t(keys[status])
}

function ServerEditor({ draft, setDraft, t, busy, onCancel, onSave }: {
  draft: Draft
  setDraft: (draft: Draft) => void
  t: (key: BrandKey) => string
  busy: boolean
  onCancel: () => void
  onSave: () => void
}): ReactNode {
  const field = <Key extends keyof Draft>(key: Key, value: Draft[Key]): void => {
    setDraft({ ...draft, [key]: value })
  }
  const fillWordPressTemplate = (): void => {
    setDraft({
      ...draft,
      command: 'npx',
      args: WORDPRESS_ARGUMENTS,
      environment: WORDPRESS_ENVIRONMENT,
    })
  }
  return (
    <div className={css.editor}>
      <div className={css.editorHeading}>
        <div>
          <h3>{draft.id === undefined ? t('mcpAddTitle') : t('mcpEditTitle')}</h3>
          <p>{t('mcpEditorIntro')}</p>
        </div>
        <span className={css.secureBadge}>{t('mcpProtected')}</span>
      </div>
      <div className={css.fieldGrid}>
        <label className={css.field}>
          <span>{t('mcpDisplayName')}</span>
          <input value={draft.name} placeholder={t('mcpDisplayNamePlaceholder')}
            onChange={(event) => { field('name', event.target.value) }} />
        </label>
        <label className={css.field}>
          <span>{t('mcpToolNamespace')}</span>
          <input value={draft.serverName} spellCheck={false} placeholder={t('mcpToolNamespacePlaceholder')}
            onChange={(event) => { field('serverName', event.target.value) }} />
        </label>
      </div>
      <fieldset className={css.transport}>
        <legend>{t('mcpConnectionType')}</legend>
        <button type="button" className={draft.transport === 'streamable-http' ? css.transportActive : undefined}
          aria-label={t('mcpRemote')}
          onClick={() => { field('transport', 'streamable-http') }}>
          <strong>{t('mcpRemote')}</strong><span>{t('mcpRemoteHint')}</span>
        </button>
        <button type="button" className={draft.transport === 'stdio' ? css.transportActive : undefined}
          aria-label={t('mcpLocal')}
          onClick={() => { field('transport', 'stdio') }}>
          <strong>{t('mcpLocal')}</strong><span>{t('mcpLocalHint')}</span>
        </button>
      </fieldset>
      {draft.transport === 'streamable-http'
        ? (
          <div className={css.stack}>
            <label className={css.field}>
              <span>{t('mcpUrl')}</span>
              <input value={draft.url} spellCheck={false} placeholder={t('mcpUrlPlaceholder')}
                onChange={(event) => { field('url', event.target.value) }} />
            </label>
            <div className={css.fieldGrid}>
              <label className={css.field}>
                <span>{t('mcpHeaderName')}</span>
                <input value={draft.headerName} spellCheck={false}
                  onChange={(event) => { field('headerName', event.target.value) }} />
              </label>
              <label className={css.field}>
                <span>{t('mcpHeaderValue')}</span>
                <input type="password" value={draft.authorization} autoComplete="off"
                  placeholder={draft.authenticationConfigured ? t('mcpKeepSecret') : t('mcpOptional')}
                  onChange={(event) => { field('authorization', event.target.value) }} />
              </label>
            </div>
          </div>
        )
        : (
          <div className={css.stack}>
            <label className={css.field}>
              <span>{t('mcpCommand')}</span>
              <input value={draft.command} spellCheck={false} placeholder={t('mcpCommandPlaceholder')}
                onChange={(event) => { field('command', event.target.value) }} />
            </label>
            <div className={css.fieldGrid}>
              <label className={css.field}>
                <span>{t('mcpArguments')}</span>
                <textarea value={draft.args} spellCheck={false} placeholder={t('mcpArgumentsPlaceholder')}
                  onChange={(event) => { field('args', event.target.value) }} />
              </label>
              <div className={css.field}>
                <div className={css.fieldLabelRow}>
                  <label htmlFor="mcp-environment">{t('mcpEnvironment')}</label>
                  <button type="button" className={css.templateButton} onClick={fillWordPressTemplate}>
                    {t('mcpWordPressTemplate')}
                  </button>
                </div>
                <textarea id="mcp-environment" value={draft.environment} spellCheck={false}
                  placeholder={t('mcpEnvironmentPlaceholder')}
                  onChange={(event) => { field('environment', event.target.value) }} />
              </div>
            </div>
            <label className={css.field}>
              <span>{t('mcpWorkingDirectory')}</span>
              <input value={draft.cwd} spellCheck={false} placeholder={t('mcpOptional')}
                onChange={(event) => { field('cwd', event.target.value) }} />
            </label>
          </div>
        )}
      {draft.authenticationConfigured
        ? (
          <label className={css.clearSecret}>
            <input type="checkbox" checked={draft.clearAuthentication}
              onChange={(event) => { field('clearAuthentication', event.target.checked) }} />
            <span>{t('mcpClearAuthentication')}</span>
          </label>
        )
        : null}
      <div className={css.editorActions}>
        <Button variant="outline" disabled={busy} onClick={onCancel}>{t('cancel')}</Button>
        <Button disabled={busy} onClick={onSave}>{busy ? t('mcpSaving') : t('mcpSave')}</Button>
      </div>
    </div>
  )
}

/** Render the global MCP registry page. */
export function McpServersSection({ operations, t }: McpServersSectionProps): ReactNode {
  const [state, setState] = useState<McpManagerState | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [removeTarget, setRemoveTarget] = useState<McpServerView | null>(null)
  const [importReview, setImportReview] = useState<McpJsonImport | null>(null)
  const importInput = useRef<HTMLInputElement | null>(null)

  const load = (): void => {
    void operations.describe().then((outcome) => {
      if (outcome.state !== undefined) setState(outcome.state)
      setError(outcome.error ?? null)
    })
  }
  useEffect(() => {
    load()
    const timer = window.setInterval(load, 3_000)
    return () => { window.clearInterval(timer) }
  }, [operations])

  const connectedCount = useMemo(
    () => state?.servers.filter(server => server.status === 'connected').length ?? 0,
    [state],
  )
  const update = (key: string, operation: Promise<McpManagerOutcome>): void => {
    setBusy(key)
    setError(null)
    void operation.then((outcome) => {
      if (outcome.state !== undefined) setState(outcome.state)
      if (outcome.error !== undefined) setError(outcome.error)
    }).finally(() => { setBusy(null) })
  }
  const save = (): void => {
    if (draft === null) return
    let input: McpServerInput
    try {
      input = inputOf(draft, t('mcpEnvironmentInvalid'))
    } catch (parseError) {
      setError(parseError instanceof Error ? parseError.message : String(parseError))
      return
    }
    setBusy('save')
    setError(null)
    void operations.save(input).then((outcome) => {
      if (outcome.state !== undefined) {
        setState(outcome.state)
        setDraft(null)
      }
      if (outcome.error !== undefined) setError(outcome.error)
    }).finally(() => { setBusy(null) })
  }

  const stageImport = (file: File): void => {
    if (state === null) return
    const existingNamespaces = state.servers.map(server => server.serverName)
    const capacity = MAX_SAVED_SERVERS - state.servers.length
    setError(null)
    setImportReview(null)
    if (file.size > MAX_IMPORT_BYTES) {
      setError(t('mcpImportTooLarge'))
      return
    }
    void file.text().then((text) => {
      const staged = parseMcpJson(
        text,
        existingNamespaces,
        capacity,
      )
      if (staged.servers.length === 0) {
        setError(t('mcpImportNoServers'))
        return
      }
      setImportReview(staged)
    }).catch(() => { setError(t('mcpImportInvalid')) })
  }

  const saveImport = (): void => {
    if (importReview === null) return
    setBusy('import')
    setError(null)
    void (async () => {
      for (const server of importReview.servers) {
        const outcome = await operations.save(server.input)
        if (outcome.state !== undefined) setState(outcome.state)
        if (outcome.error !== undefined) throw new Error(outcome.error)
      }
      setImportReview(null)
    })().catch((cause: unknown) => {
      const detail = cause instanceof Error ? cause.message : String(cause)
      setError(`${t('mcpImportStopped')} ${detail}`)
    }).finally(() => { setBusy(null) })
  }

  if (state === null) return <div className={css.section}><p className={css.loading}>{t('mcpLoading')}</p></div>
  return (
    <div className={css.section}>
      <div className={css.pageHead}>
        <div>
          <h2>{t('mcpTitle')}</h2>
          <p>{t('mcpDescription')}</p>
        </div>
        <div className={css.summary}>
          <span className={css.summaryNumber}>{connectedCount}</span>
          <span>{t('mcpConnectedSummary')}</span>
        </div>
      </div>
      {!state.available ? <p className={css.notice}>{t('mcpUnavailable')}</p> : null}
      {!state.writable && state.available ? <p className={css.notice}>{t('mcpReadOnly')}</p> : null}
      {error === null ? null : <p className={css.error} role="alert">{error}</p>}
      {draft === null
        ? (
          <>
            {state.servers.length === 0
              ? (
                <div className={css.empty}>
                  <span className={css.emptyMark}>M</span>
                  <h3>{t('mcpEmptyTitle')}</h3>
                  <p>{t('mcpEmptyDescription')}</p>
                </div>
              )
              : (
                <ul className={css.serverList}>
                  {state.servers.map(server => (
                    <li key={server.id} className={`${css.serverCard} ${css[`status-${server.status}`] ?? ''}`}>
                      <div className={css.serverHead}>
                        <div className={css.identity}>
                          <StateDot state={dotState(server.status)} />
                          <div>
                            <strong>{server.name}</strong>
                            <span>{server.endpoint}</span>
                          </div>
                        </div>
                        <div className={css.switchGroup}>
                          <span>{server.enabled ? t('mcpEnabled') : t('mcpDisabled')}</span>
                          <Switch checked={server.enabled} label={`${t('mcpToggle')}: ${server.name}`}
                            disabled={busy !== null || !state.writable}
                            onChange={(enabled) => { update(server.id, operations.setEnabled(server.id, enabled)) }} />
                        </div>
                      </div>
                      <div className={css.meta}>
                        <span className={css.statusText}>{statusText(server.status, t)}</span>
                        <code>{server.serverName}</code>
                        <span>{server.transport === 'streamable-http' ? t('mcpRemote') : t('mcpLocal')}</span>
                        {server.authenticationConfigured ? <span>{t('mcpAuthenticationSaved')}</span> : null}
                      </div>
                      {server.error === undefined ? null : <p className={css.cardError}>{server.error}</p>}
                      <div className={css.cardFoot}>
                        <details className={css.tools}>
                          <summary>{`${String(server.tools.length)} ${t('mcpTools')}`}</summary>
                          {server.tools.length === 0
                            ? <p>{t('mcpNoTools')}</p>
                            : <div>{server.tools.map(tool => <code key={tool}>{tool}</code>)}</div>}
                        </details>
                        <div className={css.actions}>
                          <Button variant="ghost" disabled={busy !== null || !server.enabled}
                            onClick={() => { update(server.id, operations.reconnect(server.id)) }}>
                            {busy === server.id ? t('mcpTesting') : t('mcpTest')}
                          </Button>
                          <Button variant="outline" disabled={busy !== null || !state.writable}
                            onClick={() => { setDraft(editDraft(server)); setError(null) }}>
                            {t('mcpEdit')}
                          </Button>
                          <Button variant="ghost" disabled={busy !== null || !state.writable}
                            onClick={() => { setRemoveTarget(server) }}>
                            {t('mcpRemove')}
                          </Button>
                        </div>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            {importReview === null
              ? null
              : (
                <section className={css.importReview} aria-label={t('mcpImportReviewTitle')}>
                  <div className={css.importHeading}>
                    <div>
                      <h3>{t('mcpImportReviewTitle')}</h3>
                      <p>{t('mcpImportReviewDescription')}</p>
                    </div>
                    <span className={css.secureBadge}>{t('mcpProtected')}</span>
                  </div>
                  <ul className={css.importList}>
                    {importReview.servers.map(server => (
                      <li key={`${server.sourceName}:${server.input.serverName}`}>
                        <div>
                          <strong>{server.input.name}</strong>
                          <code>{server.input.serverName}</code>
                        </div>
                        <span>
                          {server.input.transport === 'stdio' ? t('mcpLocal') : t('mcpRemote')}
                          {' · '}
                          {server.input.enabled ? t('mcpEnabled') : t('mcpDisabled')}
                          {' · '}
                          {t('mcpImportProtectedValues', { count: String(server.protectedValueCount) })}
                        </span>
                      </li>
                    ))}
                  </ul>
                  {importReview.skippedNames.length === 0
                    ? null
                    : <p className={css.importWarning}>{t('mcpImportSkipped', { count: String(importReview.skippedNames.length) })}</p>}
                  {importReview.ignoredTimeoutCount === 0
                    ? null
                    : <p className={css.importWarning}>{t('mcpImportTimeoutIgnored')}</p>}
                  {importReview.ignoredHeaderCount === 0
                    ? null
                    : <p className={css.importWarning}>{t('mcpImportHeadersIgnored')}</p>}
                  {importReview.capacitySkippedCount === 0
                    ? null
                    : <p className={css.importWarning}>{t('mcpImportCapacity')}</p>}
                  <div className={css.editorActions}>
                    <Button variant="outline" disabled={busy !== null}
                      onClick={() => { setImportReview(null) }}>{t('cancel')}</Button>
                    <Button disabled={busy !== null} onClick={saveImport}>
                      {busy === 'import' ? t('mcpImportSaving') : t('mcpImportConfirm')}
                    </Button>
                  </div>
                </section>
              )}
            <div className={css.addActions}>
              <button type="button" className={css.addButton} disabled={!state.writable}
                onClick={() => { setDraft(blankDraft()); setImportReview(null); setError(null) }}>
                <span>+</span>{t('mcpAdd')}
              </button>
              <Button variant="outline" disabled={!state.writable || busy !== null}
                onClick={() => { importInput.current?.click() }}>
                {t('mcpImport')}
              </Button>
              <input
                ref={importInput}
                className={css.fileInput}
                type="file"
                accept=".json,application/json"
                aria-label={t('mcpImportFile')}
                onChange={(event) => {
                  const file = event.target.files?.[0]
                  event.target.value = ''
                  if (file !== undefined) stageImport(file)
                }}
              />
            </div>
            <p className={css.privacy}>{t('mcpPrivacy')}</p>
          </>
        )
        : <ServerEditor draft={draft} setDraft={setDraft} t={t} busy={busy !== null}
          onCancel={() => { setDraft(null); setError(null) }} onSave={save} />}
      <Modal open={removeTarget !== null} onClose={() => { setRemoveTarget(null) }}
        title={t('mcpRemoveTitle')} closeLabel={t('close')} description={t('mcpRemoveDescription')}
        footer={<><Button variant="outline" onClick={() => { setRemoveTarget(null) }}>{t('cancel')}</Button>
          <Button variant="outline" disabled={busy !== null} onClick={() => {
            if (removeTarget === null) return
            const id = removeTarget.id
            setBusy(id)
            void operations.remove(id).then((outcome) => {
              if (outcome.state !== undefined) { setState(outcome.state); setRemoveTarget(null) }
              if (outcome.error !== undefined) setError(outcome.error)
            }).finally(() => { setBusy(null) })
          }}>{t('mcpRemove')}</Button></>}>
        {removeTarget === null ? null : <p className={css.removeName}>{removeTarget.name}</p>}
      </Modal>
    </div>
  )
}
