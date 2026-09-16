/** Renderer-owned mirror of the delegation settings section. */
import { defineStore, type EngineStoreHandle } from '@deepseek-ai/dsh-client-store'
import type { SettingsScopeSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { CommandCodeDelegationSettings } from './contract.ts'

/** State rendered by the Delegation settings section. */
export interface DelegationSectionState {
  status: SettingsScopeSnapshot<CommandCodeDelegationSettings>['status']
  writable: boolean
  value: CommandCodeDelegationSettings | undefined
}

/** Actions the settings transport pushes into the section store. */
export type DelegationSectionActions = {
  /** Fold the latest settings projection into the rendered state. */
  sync: (state: DelegationSectionState, next: DelegationSectionState) => void
}

/**
 * Create the store mounted with Harnessy's Delegation section.
 * @returns the store handle shared by the settings transport and the section.
 */
export function createDelegationSectionStore(): EngineStoreHandle<DelegationSectionState, DelegationSectionActions> {
  return defineStore({
    init: (): DelegationSectionState => ({ status: 'loading', writable: false, value: undefined }),
    actions: {
      sync: (state, next) => {
        state.status = next.status
        state.writable = next.writable
        state.value = next.value
      },
    },
  })
}
