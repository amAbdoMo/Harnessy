// @vitest-environment jsdom
/** Headerless Session accounts through test-only YAML, the real client Loader, and sidebar renderer. */
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import Include from '@deepseek-ai/cordis-plugin-include'
import { act, createEvent, fireEvent, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, vi } from 'vitest'
import { ok, openStream } from '@deepseek-ai/dsh-remote-mock'
import { createClientTest, webApp, type ClientTestFixtures } from '@deepseek-ai/dsh-client-test-runtime/src/assembly/index.ts'
import type { SessionSummary } from '@deepseek-ai/dsh-api-session-controller/types'
import type { WorkspaceId } from '@deepseek-ai/dsh-api-workspace-controller/client'
import { SESSION_FORMAT_VERSION, type SessionId } from '@deepseek-ai/dsh-session/types'
import * as workspacePlugin from '../src/client/index.ts'
import { en, zh } from '../src/client/locales.ts'
import { UNGROUPED_KEY } from '../src/client/tree.ts'

const FEATURE = '@deepseek-ai/dsh-client-ui-workspace'
const test = createClientTest({
  roster: webApp.closure([FEATURE]),
  provide: {
    [FEATURE]: {
      inject: workspacePlugin.inject,
      apply: async (ctx) => {
        ctx.loader.builtins.include = Include
        ctx.loader.builtins.workspaceUnderTest = workspacePlugin
        await ctx.loader.create({ name: 'cordis:include', config: {
          path: pathToFileURL(resolve(import.meta.dirname, 'fixtures/headerless/cordis.yml')).href,
        } })
      },
    },
  },
})
const timestamp = '2026-01-01T00:00:00.000Z'
const sid = (id: string) => id as SessionId
const wid = (id: string) => id as WorkspaceId
const sessions = Array.from({ length: 7 }, (_, index) => ({
  sessionId: sid(`loose-${index + 1}`), updatedAt: 7 - index,
  projections: { kind: 'cached', asOfSeq: -1, values: { title: `Loose ${index + 1}` } },
  agentAvailable: false, running: false, blank: false,
} satisfies SessionSummary))
const alpha = {
  workspaceId: wid('alpha'), title: 'Alpha', path: '/projects/alpha', sessionIds: [sid('owned')],
  createdAt: timestamp, updatedAt: timestamp,
}
let savedStorage: [string, string][]
let savedLanguage: string | null
beforeEach(() => {
  savedStorage = Array.from({ length: localStorage.length }, (_, index) => {
    const key = localStorage.key(index)!
    return [key, localStorage.getItem(key)!]
  })
  savedLanguage = document.documentElement.getAttribute('lang')
  localStorage.clear()
})
afterEach(() => {
  vi.restoreAllMocks()
  localStorage.clear()
  for (const [key, value] of savedStorage) localStorage.setItem(key, value)
  if (savedLanguage === null) document.documentElement.removeAttribute('lang')
  else document.documentElement.setAttribute('lang', savedLanguage)
})

function visibleRows(tree: HTMLElement): string[] {
  return within(tree).getAllByRole('treeitem').map((row) => {
    const title = row.querySelector('[class*="title"]')?.textContent
    const expanded = row.getAttribute('aria-expanded')
    return expanded === null ? `Session: ${title}` : `Workspace: ${title} (${expanded === 'true' ? 'expanded' : 'collapsed'})`
  })
}

function dropBefore(source: HTMLElement, target: HTMLElement): void {
  fireEvent.dragStart(source, { dataTransfer: { effectAllowed: '', setData: () => {} } })
  const event = createEvent.drop(target)
  Object.defineProperty(event, 'clientY', { value: -1 })
  Object.defineProperty(event, 'dataTransfer', { value: { dropEffect: '', types: [] } })
  fireEvent(target, event)
}

type SidebarCase = {
  locale: string
  copy: typeof en | typeof zh
  groupBy: string
  expansion: Record<string, boolean>
}

test.for([
  { locale: 'en', copy: en, groupBy: 'workspace', expansion: { [UNGROUPED_KEY]: false } },
  { locale: 'zh', copy: zh, groupBy: 'workspace-tree', expansion: {} },
] satisfies SidebarCase[])('keeps loose rows directly visible and account-owned in $locale $groupBy', { timeout: 60_000 }, async ({ locale, copy, groupBy, expansion }, { mock, start }: ClientTestFixtures) => {
  vi.spyOn(navigator, 'languages', 'get').mockReturnValue([locale])
  localStorage.setItem('dsh.workspace.view.v5', JSON.stringify({
    groupBy, orderBy: 'manual', groupExpansion: expansion, sessionOrderByAccount: {}, archivedFilter: 'default',
  }))
  localStorage.setItem('dsh.sessions.current', JSON.stringify({ sessionId: 'loose-1' }))
  mock.unary('session/projections', ok({ asOfSeq: -1, values: { title: 'Loose 1' } }))
  mock.stream('session/follow', openStream([{ type: 'snapshot', cursor: -1, records: [], hasMore: false,
    header: { version: SESSION_FORMAT_VERSION, id: sid('loose-1'), createdAt: 1, isSeeded: false },
    projections: { asOfSeq: -1, values: { title: 'Loose 1' } }, assistantStream: { revision: 0 },
  }]))
  mock.unary('session/list', ok({ items: [...sessions, {
    sessionId: sid('owned'), updatedAt: 1, agentAvailable: false, running: false, blank: false,
    projections: { kind: 'cached', asOfSeq: -1, values: { title: 'Owned' } },
  }] }))
  mock.stream('workspace/follow', openStream([{ type: 'baseline', value: {
    items: [alpha], archivedSessionIds: [], pinnedSessionIds: [sid('loose-7')],
  } }]))
  const client = await start()
  const container = document.createElement('div')
  document.body.append(container)
  let unmount: (() => void) | undefined
  try {
    await act(async () => { unmount = client.ctx.uiRenderer.mount(container) })
    await client.flush()
    const tree = await screen.findByRole('tree', { name: copy['section.sessions'] })
    expect(visibleRows(tree)).toEqual([
      'Workspace: Alpha (collapsed)', 'Session: Loose 7', ...sessions.slice(0, 6).map(row => `Session: ${row.projections.values.title}`),
    ])
    expect(within(tree).queryByText(copy['group.ungrouped'])).toBeNull()
    expect(within(tree).queryByRole('button', { name: /Show \d|展开其余|Show less|收起/ })).toBeNull()
    const evidence = visibleRows(tree).join('\n')
    fireEvent.click(within(tree).getByRole('button', { name: copy['actions.workspace.aria'].replace('{name}', 'Alpha') }))
    fireEvent.click(screen.getByRole('menuitem', { name: copy['delete.workspace'] }))
    const dialog = screen.getByRole('dialog', { name: copy['delete.workspace'] })
    await expect(`${evidence}\n\n${dialog.textContent}\n`).toMatchFileSnapshot(`./expected/headerless-${locale}.txt`)
    fireEvent.keyDown(document, { key: 'Escape' })

    dropBefore(within(tree).getByText('Loose 6').closest('[role="treeitem"]') as HTMLElement,
      within(tree).getByText('Loose 1').closest('[role="treeitem"]') as HTMLElement)
    const persisted = JSON.parse(localStorage.getItem('dsh.workspace.view.v5')!) as {
      sessionOrderByAccount: Record<string, string[]>
    }
    expect(persisted.sessionOrderByAccount[UNGROUPED_KEY]).toEqual([
      'loose-7', 'loose-6', 'loose-1', 'loose-2', 'loose-3', 'loose-4', 'loose-5',
    ])
    await act(async () => {
      mock.streams.push('workspace/follow', { type: 'upsert', workspace: { ...alpha, sessionIds: [...alpha.sessionIds, sid('loose-6')] } })
      await mock.streams.drained('workspace/follow')
    })
    await client.flush()
    expect(within(tree).queryByText('Loose 6')).toBeNull()
    fireEvent.click(within(tree).getByText('Alpha'))
    expect(within(tree).getAllByText('Loose 6')).toHaveLength(1)
    expect(within(tree).getByText('Loose 5')).toBeTruthy()
    expect(client.ctx.workspaces.list.getSnapshot().items[0]?.sessionIds).toEqual(['owned', 'loose-6'])
    expect(mock.remote.workspace.delete).not.toHaveBeenCalled()
    expect(mock.remote.workspace.archiveSession).not.toHaveBeenCalled()
  } finally {
    await act(async () => { unmount?.() })
    container.remove()
  }
})
