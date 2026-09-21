/** Renderer-owned mirror of new-Session workspace preferences. */

import { defineStore, type EngineStoreHandle } from '@deepseek-ai/dsh-client-store'
import type { SessionWorkspaceSettings } from '../session-workspace.ts'
import type { SettingsScopeSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'

/** State rendered by Harnessy's Session workspace settings row. */
export interface SessionWorkspaceRowState {
  status: SettingsScopeSnapshot<SessionWorkspaceSettings>['status']
  writable: boolean
  mode: SessionWorkspaceSettings['mode']
  remoteRoot: string
}

type SessionWorkspaceRowActions = {
  sync: (
    state: SessionWorkspaceRowState,
    snapshot: SettingsScopeSnapshot<SessionWorkspaceSettings>,
  ) => void
}

/**
 * Create the reactive store mounted with Harnessy's Session workspace row.
 * @returns the store handle shared by the settings transport and row.
 */
export function createSessionWorkspaceRowStore(): EngineStoreHandle<
  SessionWorkspaceRowState,
  SessionWorkspaceRowActions
> {
  return defineStore({
    init: (): SessionWorkspaceRowState => ({
      status: 'loading', writable: false, mode: 'harnessy-default', remoteRoot: '',
    }),
    actions: {
      sync: (state, snapshot) => {
        state.status = snapshot.status
        state.writable = snapshot.writable
        if (snapshot.value === undefined) return
        state.mode = snapshot.value.mode
        state.remoteRoot = snapshot.value.remoteRoot
      },
    },
  })
}
