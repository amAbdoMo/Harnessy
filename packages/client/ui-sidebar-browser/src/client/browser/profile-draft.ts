/** Session-local pairing form drafts survive Browser remounts without entering persistent storage. */
import { defineStore, type EngineStoreHandle } from '@deepseek-ai/dsh-client-store'
import type { DesktopWebsiteProfileInput } from '../../types.ts'

type WebsiteProfileDraft = { -readonly [K in keyof DesktopWebsiteProfileInput]: DesktopWebsiteProfileInput[K] }
type DraftActions = {
  edit: <K extends keyof WebsiteProfileDraft>(draft: WebsiteProfileDraft, field: K, value: WebsiteProfileDraft[K]) => void
  discard: (draft: WebsiteProfileDraft) => void
}

/**
 * Declare a session-local pairing draft without persisting website/account input.
 * @returns a fresh declaration for the profile toolbar registration.
 */
export function createWebsiteProfileDraftStore(): EngineStoreHandle<WebsiteProfileDraft, DraftActions> {
  return defineStore({
    init: (): WebsiteProfileDraft => ({ name: '', accountLabel: '', url: '', mcpServerName: '', access: 'automatic' }),
    actions: {
      edit: <K extends keyof WebsiteProfileDraft>(draft: WebsiteProfileDraft, field: K, value: WebsiteProfileDraft[K]) => {
        draft[field] = value
      },
      discard: (draft) => { draft.name = ''; draft.accountLabel = ''; draft.url = ''; draft.mcpServerName = ''; draft.access = 'automatic' },
    },
  })
}
