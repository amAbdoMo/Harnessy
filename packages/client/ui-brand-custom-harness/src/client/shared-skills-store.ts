/** Renderer-owned mirror of the shared-skills settings scope. */
import { defineStore, type EngineStoreHandle } from '@deepseek-ai/dsh-client-store'
import type { SettingsScopeSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { SharedSkillsSettings } from '../shared-skills.ts'

/** State rendered by the General-settings shared-skills row. */
export interface SharedSkillsRowState {
  status: SettingsScopeSnapshot<SharedSkillsSettings>['status']
  enabled: boolean
  directory: string
  defaultDirectory: string
  writable: boolean
  revision: number
}

type SharedSkillsRowActions = {
  sync: (state: SharedSkillsRowState, snapshot: SettingsScopeSnapshot<SharedSkillsSettings>) => void
}

function baseDirectory(snapshot: SettingsScopeSnapshot<SharedSkillsSettings>): string {
  const base = snapshot.base
  if (typeof base !== 'object' || base === null || Array.isArray(base)) return snapshot.value?.directory ?? ''
  const directory = (base as { directory?: unknown }).directory
  return typeof directory === 'string' ? directory : snapshot.value?.directory ?? ''
}

/**
 * Create the store mounted with Harnessy's shared-skills row.
 * @returns the store handle shared by the settings transport and row.
 */
export function createSharedSkillsRowStore(): EngineStoreHandle<SharedSkillsRowState, SharedSkillsRowActions> {
  return defineStore({
    init: (): SharedSkillsRowState => ({
      status: 'loading', enabled: true, directory: '', defaultDirectory: '', writable: false, revision: -1,
    }),
    actions: {
      sync: (state, snapshot: SettingsScopeSnapshot<SharedSkillsSettings>) => {
        state.status = snapshot.status
        state.writable = snapshot.writable
        state.revision = snapshot.revision ?? state.revision
        if (snapshot.value === undefined) return
        state.enabled = snapshot.value.enabled
        state.directory = snapshot.value.directory
        state.defaultDirectory = baseDirectory(snapshot)
      },
    },
  })
}
