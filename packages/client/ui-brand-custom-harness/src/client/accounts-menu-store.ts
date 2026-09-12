/** Shared viewing state for the sidebar account launcher and Accounts modal. */
import { defineStore } from '@deepseek-ai/dsh-client-store'

/** Transient request shared by the two account-menu slot occupants. */
export interface AccountsMenuState {
  managerRequested: boolean
}

/**
 * Create the account-menu viewing store shared by its launcher and modal entry.
 * @returns the store handle installed on both root-scoped registrations.
 */
export function createAccountsMenuStore() {
  return defineStore({
    init: (): AccountsMenuState => ({ managerRequested: false }),
    actions: {
      requestManager: (state) => { state.managerRequested = true },
      consumeManagerRequest: (state) => { state.managerRequested = false },
    },
  })
}
