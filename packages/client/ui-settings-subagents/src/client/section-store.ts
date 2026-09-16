/** Renderer-owned mirror of the `subagent-roster` settings section. */
import { defineStore, type EngineStoreHandle } from '@deepseek-ai/dsh-client-store'
import type { SettingsScopeSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { SubagentSettings } from '@deepseek-ai/dsh-api-remotes/client'

/** State rendered by the Subagents settings section. */
export interface SubagentsSectionState {
  status: SettingsScopeSnapshot<SubagentSettings>['status']
  writable: boolean
  /** Namespace revision the page fences its next write with. */
  revision: number | undefined
  value: SubagentSettings | undefined
}

/** Actions the settings transport pushes into the section store. */
export type SubagentsSectionActions = {
  /** Fold the latest settings projection into the rendered state. */
  sync: (state: SubagentsSectionState, next: SubagentsSectionState) => void
}

/**
 * Create the store mounted with Harnessy's Subagents section.
 * @returns the store handle shared by the settings transport and the section.
 */
export function createSubagentsSectionStore(): EngineStoreHandle<SubagentsSectionState, SubagentsSectionActions> {
  return defineStore({
    init: (): SubagentsSectionState => ({ status: 'loading', writable: false, revision: undefined, value: undefined }),
    actions: {
      sync: (state, next) => {
        state.status = next.status
        state.writable = next.writable
        state.revision = next.revision
        state.value = next.value
      },
    },
  })
}
