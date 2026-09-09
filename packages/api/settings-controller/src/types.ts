/**
 * Browser-safe failure vocabulary of the configuration surfaces this package
 * serves. The redacted views themselves live with their seam in
 * `@deepseek-ai/dsh-settings/types`, whose Cordis event declarations already
 * register that file for the Client compilation face.
 *
 * @module @deepseek-ai/dsh-api-settings-controller/types
 */

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /**
     * Every seam refusal that is not a stale write: an unregistered or malformed
     * namespace, a read-only provider, schema validation, storage.
     */
    'settings/rejected': { readonly ns: string }
    /**
     * The stored revision moved after the caller read it. Its own outcome rather
     * than an invalid request: the caller must re-read and re-apply.
     */
    'settings/conflict': { readonly ns: string; readonly expected: number; readonly actual: number }
    /**
     * The provider refused a valid credential write, for example because a
     * read-only source shadows the reference. The details name only the
     * reference, never the value.
     */
    'credential/rejected': { readonly ref: string }
    /** The OpenAI account flow or one of its required Host services is unavailable. */
    'openai-account/unavailable': Record<string, never>
    /** The operating system refused to open the secure OpenAI sign-in page. */
    'openai-account/browser-failed': Record<string, never>
  }
}

/** Browser-safe OpenAI account status. OAuth material is intentionally absent. */
export interface OpenAIAccountState {
  readonly available: boolean
  readonly configured: boolean
  readonly inFlight: boolean
  readonly writable: boolean
}

/** Terminal result of a cancellable OpenAI account attempt. */
export interface OpenAIAccountSignInResult {
  readonly status: 'authorized' | 'cancelled'
}

/** Confirmation that the settings document was handed to the native editor. */
export interface SettingsDocumentOpenValue {
  readonly opened: true
}

/** Result of opening or revealing one locally authored Agent preset directory. */
export type AgentPresetDirectoryOpenValue =
  | { readonly opened: true }
  | { readonly opened: false; readonly path: string }
