/** Session-local pairing form drafts survive Browser remounts without entering persistent storage. */
import { defineStore, type EngineStoreHandle } from '@deepseek-ai/dsh-client-store'
import type { DesktopWebsiteProfileInput } from '../../types.ts'

type WebsiteProfileDraft = { -readonly [K in keyof DesktopWebsiteProfileInput]: DesktopWebsiteProfileInput[K] }
type DraftActions = {
  edit: (draft: WebsiteProfileDraft, field: keyof DesktopWebsiteProfileInput, value: string) => void
  discard: (draft: WebsiteProfileDraft) => void
}

/**
 * Declare a session-local pairing draft without persisting website/account input.
 * @returns a fresh declaration for the profile toolbar registration.
 */
export function createWebsiteProfileDraftStore(): EngineStoreHandle<WebsiteProfileDraft, DraftActions> {
  return defineStore({
    init: (): WebsiteProfileDraft => ({ name: '', accountLabel: '', url: '', mcpServerName: '' }),
    actions: {
      edit: (draft, field: keyof DesktopWebsiteProfileInput, value: string) => { draft[field] = value },
      discard: (draft) => { draft.name = ''; draft.accountLabel = ''; draft.url = ''; draft.mcpServerName = '' },
    },
  })
}
