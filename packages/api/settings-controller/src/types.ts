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
    /** The Harnessy account manager or one of its Host dependencies is unavailable. */
    'accounts/unavailable': Record<string, never>
    /** The requested managed account does not exist. */
    'accounts/not-found': { readonly provider: AccountProviderId; readonly accountId: string }
    /** The requested account operation is not valid for this provider or account. */
    'accounts/rejected': { readonly provider: AccountProviderId }
    /** The Harnessy MCP manager or one of its required Host services is unavailable. */
    'mcp-manager/unavailable': Record<string, never>
    /** The requested MCP server does not exist. */
    'mcp-manager/not-found': { readonly serverId: string }
    /** The requested MCP server profile is invalid or cannot be stored. */
    'mcp-manager/rejected': { readonly serverId?: string }
  }
}

/** Transport supported by Harnessy's MCP manager. */
export type McpServerTransport = 'streamable-http' | 'stdio'

/** Live state of one saved MCP server. */
export type McpServerStatus = 'disabled' | 'connecting' | 'connected' | 'reconnecting' | 'error'

/** Secret-free saved server profile returned to the Harnessy client. */
export interface McpServerView {
  readonly id: string
  readonly name: string
  readonly serverName: string
  readonly transport: McpServerTransport
  readonly enabled: boolean
  readonly endpoint: string
  readonly headerName?: string
  readonly args: readonly string[]
  readonly cwd?: string
  readonly status: McpServerStatus
  readonly tools: readonly string[]
  readonly error?: string
  readonly authenticationConfigured: boolean
  readonly environmentKeys: readonly string[]
  readonly updatedAt: number
}

/** Complete redacted snapshot of Harnessy's global MCP server registry. */
export interface McpManagerState {
  readonly available: boolean
  readonly writable: boolean
  readonly servers: readonly McpServerView[]
}

/** Add or edit input. Authentication values are accepted but never returned. */
export interface McpServerInput {
  readonly id?: string
  readonly name: string
  readonly serverName: string
  readonly transport: McpServerTransport
  readonly enabled: boolean
  readonly url?: string
  readonly headerName?: string
  readonly authorization?: string
  readonly command?: string
  readonly args?: readonly string[]
  readonly cwd?: string
  readonly environment?: Readonly<Record<string, string>>
  readonly clearAuthentication?: boolean
}

/** Providers currently presented by Harnessy's local account manager. */
export type AccountProviderId = 'openai-codex' | 'zai' | 'kimi-coding' | 'opencode' | 'anthropic'

/** Authentication experience offered for a managed provider. */
export type AccountAuthMode = 'oauth' | 'api-key'

/** Browser-safe provider metadata for the account-manager selector. */
export interface AccountProviderView {
  readonly id: AccountProviderId
  readonly label: string
  readonly authMode: AccountAuthMode
  readonly available: boolean
  readonly accountCount: number
  readonly activeAccountId?: string
  readonly usageAvailable: boolean
}

/** One quota interval returned by a provider-supported usage service. */
export interface AccountUsageWindow {
  readonly id: string
  readonly label: string
  readonly usedPercent: number
  readonly resetsAtMs?: number
}

/** Usage snapshot attached to a managed account. */
export interface AccountUsageView {
  readonly windows: readonly AccountUsageWindow[]
}

/** Secret-free account row returned to the Harnessy client. */
export interface ManagedAccountView {
  readonly id: string
  readonly provider: AccountProviderId
  readonly name: string
  readonly detail?: string
  readonly initials: string
  readonly active: boolean
  readonly authMode: AccountAuthMode
  readonly usage?: AccountUsageView
  readonly usageUpdatedAt?: number
  readonly usageError?: string
}

/** Complete browser-safe snapshot of Harnessy's managed provider accounts. */
export interface AccountsState {
  readonly writable: boolean
  readonly providers: readonly AccountProviderView[]
  readonly accounts: readonly ManagedAccountView[]
}

/** Terminal result of a cancellable provider account sign-in. */
export interface AccountSignInResult {
  readonly status: 'authorized' | 'cancelled'
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
