/** Shared viewing state for the sidebar account launcher and Accounts modal. */
import { defineStore, type EngineStoreHandle } from '@deepseek-ai/dsh-client-store'

/** Transient request shared by the two account-menu slot occupants. */
export interface AccountsMenuState {
  managerRequested: boolean
  sectionRequested: string | undefined
}

type AccountsMenuActions = {
  requestManager: (state: AccountsMenuState) => void
  consumeManagerRequest: (state: AccountsMenuState) => void
  requestSection: (state: AccountsMenuState, id: string) => void
  consumeSectionRequest: (state: AccountsMenuState) => void
}

/**
 * Create the account-menu viewing store shared by its launcher and modal entry.
 * @returns the store handle installed on both root-scoped registrations.
 */
export function createAccountsMenuStore(): EngineStoreHandle<AccountsMenuState, AccountsMenuActions> {
  return defineStore({
    init: (): AccountsMenuState => ({ managerRequested: false, sectionRequested: undefined }),
    actions: {
      requestManager: (state) => { state.managerRequested = true },
      consumeManagerRequest: (state) => { state.managerRequested = false },
      requestSection: (state, id) => { state.sectionRequested = id },
      consumeSectionRequest: (state) => { state.sectionRequested = undefined },
    },
  })
}
