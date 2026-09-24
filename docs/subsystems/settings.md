# Plugin Configuration Forms

English | [中文](settings.zh.md)

The [settings service](../../packages/settings/settings/README.md) projects volatile Config fields from active profile entries. The [configuration editor](../../packages/boot/config-editor/README.md) persists edits through Cordis patches. Business consumers read `.get()` on their own Config references.

## Identity and values

A form namespace is the local id of a uniquely addressed entry in the active profile. Multiple plugin instances have separate forms when their entry ids differ. Ordinary fields are excluded. Descriptors carry resolved values, inherited values, explicit profile overrides, and an optimistic revision.

## Edits

`update` merges submitted fields. `replace` resets live fields to inherited configuration before applying submitted fields. `mutate` addresses individual paths, preserving secrets absent from a client response. Every write validates the complete Config and refuses stale revisions before persistence.

`settings/document-updated` invalidates form descriptors after Loader configuration changes. It is a UI notification; consumers use `loader/volatile-update` only when they need to refresh registration facts.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxaccountscontroller--accountscontroller"></a>

### `ctx.accountsController` — `AccountsController`

Manage several local identities per provider while keeping one canonical active credential at the existing `llm-pi-ai/<provider>` address.

```ts cordis-catalog
/**
 * Return every managed account without returning its stored credential.
 * @returns the public provider/account state, including whether the vault accepts writes.
 */
@Remote async describe(): Promise<AccountsState>

/**
 * Add an OAuth-backed identity through the provider's installed browser flow.
 * A later account is saved without replacing the currently active identity.
 * @param provider - installed OAuth-capable provider to authorize.
 * @param signal - cancellation for browser opening, prompts, and provider authorization.
 * @returns whether authorization completed or the user cancelled it.
 */
@Remote async addOAuth(provider: AccountProviderId, signal: AbortSignal): Promise<AccountSignInResult>

/**
 * Add a named API-key identity; only the first account becomes active automatically.
 * @param provider - installed API-key provider that will own the identity.
 * @param name - user-visible local label, bounded before storage.
 * @param key - secret API key written to the protected credential vault.
 * @returns the updated public account state with credentials omitted.
 */
@Remote async addApiKey(provider: AccountProviderId, name: string, key: string): Promise<AccountsState>

/**
 * Make one saved identity the canonical credential used by model requests.
 * @param provider - provider whose active identity changes.
 * @param accountId - saved identity to promote.
 * @returns the updated public account state with credentials omitted.
 */
@Remote async activate(provider: AccountProviderId, accountId: string): Promise<AccountsState>

/**
 * Enable or disable automatic Codex failover after a supported quota reaches its limit.
 * @param provider - provider whose failover preference changes; only Codex supports it.
 * @param enabled - whether fresh usage checks may promote an eligible saved account.
 * @returns the updated public account state with credentials omitted.
 */
@Remote async setAutoSwitch(provider: AccountProviderId, enabled: boolean): Promise<AccountsState>

/**
 * Rename one local account without changing its credential or active state.
 * @param provider - provider containing the saved identity.
 * @param accountId - saved identity to rename.
 * @param name - new user-visible label, bounded before storage.
 * @returns the updated public account state with credentials omitted.
 */
@Remote async rename(provider: AccountProviderId, accountId: string, name: string): Promise<AccountsState>

/**
 * Remove one saved identity and promote the next identity when it was active.
 * @param provider - provider containing the saved identity.
 * @param accountId - saved identity to remove.
 * @returns the updated public account state with credentials omitted.
 */
@Remote async deleteAccount(provider: AccountProviderId, accountId: string): Promise<AccountsState>

/**
 * Refresh every supported usage snapshot for account-management and status surfaces.
 * @param signal - cancellation checked between accounts and forwarded to usage requests.
 * @returns the updated public account state with refreshed usage when available.
 */
@Remote async refreshUsage(signal: AbortSignal): Promise<AccountsState>
```

Source: [`packages/api/settings-controller/src/accounts.ts`](../../packages/api/settings-controller/src/accounts.ts)

<a id="ctxmcpmanagercontroller--mcpmanagercontroller"></a>

### `ctx.mcpManagerController` — `McpManagerController`

Host controller for Harnessy's protected, live MCP server registry.

```ts cordis-catalog
/**
 * Return every saved server without authentication values.
 * @returns redacted registry state and live connection snapshots.
 */
@Remote describe(): Promise<McpManagerState>

/**
 * Materialize and open the dedicated MCP registry document.
 * @param signal - caller lifetime; abort terminates the native open command.
 * @returns confirmation after the operating system accepts the document.
 */
@Remote openConfigurationFile(signal: AbortSignal): Promise<SettingsDocumentOpenValue>

/**
 * Add or replace one protected server profile and reconcile its connection.
 * @param input - complete staged profile; omitted secret fields retain saved values on edit.
 * @returns redacted registry state after reconciliation.
 */
@Remote save(input: McpServerInput): Promise<McpManagerState>

/**
 * Enable or disable one saved server. Disabled servers publish no tools.
 * @param serverId - stable identifier returned by {@link describe}.
 * @param enabled - whether Harnessy should supervise the connection.
 * @returns redacted registry state after reconciliation.
 */
@Remote setEnabled(serverId: string, enabled: boolean): Promise<McpManagerState>

/**
 * Restart an enabled server immediately and wait for its first connection attempt.
 * @param serverId - stable identifier returned by {@link describe}.
 * @returns redacted registry state after the attempt settles.
 */
@Remote reconnect(serverId: string): Promise<McpManagerState>

/**
 * Remove one saved server and unregister all tools it owns.
 * @param serverId - stable identifier returned by {@link describe}.
 * @returns redacted registry state after removal.
 */
@Remote deleteServer(serverId: string): Promise<McpManagerState>
```

Source: [`packages/api/settings-controller/src/mcp-manager.ts`](../../packages/api/settings-controller/src/mcp-manager.ts)

<a id="ctxopenaiaccountcontroller--openaiaccountcontroller"></a>

### `ctx.openAIAccountController` — `OpenAIAccountController`

Expose the one-click ChatGPT OAuth path used by Harnessy. The neutral authorization service still owns the provider conversation and token write; this controller supplies the Windows-desktop interaction: browser login and a cancellable wait for the local OAuth callback.

```ts cordis-catalog
/**
 * Return account availability and local sign-in state without exposing a token.
 * @returns Redacted availability, configuration, progress, and writability state.
 */
@Remote async describe(): Promise<OpenAIAccountState>

/**
 * Start ChatGPT browser OAuth, wait for its local callback, then activate the
 * OpenAI Codex provider route so its models appear immediately.
 * @param signal - Remote request lifetime; aborting it cancels the login attempt.
 * @returns Whether the provider completed or cancelled authorization.
 */
@Remote async signIn(signal: AbortSignal): Promise<OpenAIAccountSignInResult>

/** Remove the local OAuth grant and the model route that depends on it. */
@Remote async signOut(): Promise<void>
```

Source: [`packages/api/settings-controller/src/openai-account.ts`](../../packages/api/settings-controller/src/openai-account.ts)

<a id="ctxsettings--settingsforms"></a>

### `ctx.settings` — `SettingsForms`

Project Config schemas into forms and own optional instance-level UI policy.

```ts cordis-catalog
/**
 * Wait until the removed settings document has either been imported or found absent.
 * @returns fulfillment after the one-time import attempt completes.
 */
whenInitialImportSettles(): Promise<void>

/** Register the calling plugin instance's page policy without changing its Config.
 * @param presentation Automatic-page policy for this instance; `auto` defaults to true.
 * @param owner Plugin instance the policy belongs to; defaults to the calling fiber.
 * @returns Disposer; register it with the calling plugin's effects.
 * @throws If this instance already has a registered policy.
 */
configure(presentation: { auto?: boolean }, owner: Fiber = this.ctx.fiber): () => void

/** Locate the profile patch for native editing.
 * @returns The existing profile patch path.
 */
prepareDocument(): Promise<string>

/** Read active plugin schemas and their live values.
 * @param options Redaction required for remote callers.
 * @returns Forms keyed by unique profile entry ids.
 */
describe(options?: SettingsDescribeOptions): SettingsDescriptor[]

/** Merge editable fields into an entry's config.
 * @param ns Profile entry id.
 * @param patch Fields to merge.
 * @param expectedRevision Revision returned by describe.
 */
async update(ns: string, patch: object, expectedRevision?: number): Promise<void>

/** Reset all live fields, then set the supplied fields; ordinary config is preserved.
 * @param ns Profile entry id.
 * @param section Complete form values.
 * @param expectedRevision Revision returned by describe.
 */
async replace(ns: string, section: object, expectedRevision?: number): Promise<void>

/** Apply field edits without restating redacted secrets; unsetting an array index removes its element.
 * @param ns Profile entry id.
 * @param ops Ordered form edits.
 * @param expectedRevision Revision returned by describe.
 */
async mutate(ns: string, ops: readonly SettingsPathOp[], expectedRevision?: number): Promise<void>
```

Source: [`packages/settings/settings/src/index.ts`](../../packages/settings/settings/src/index.ts)

<a id="ctxsettingscontroller--settingscontroller"></a>

### `ctx.settingsController` — `SettingsController`

Host service backing the generated `ctx.remote.settings` namespace. Every remote read uses `redactSecrets: true`, so a `role('secret')` field cannot ride a response. Writes expose the settings service's merge, replacement, and path-addressed operations, and classify every provider refusal as `settings/conflict` or `settings/rejected` with the service's message.

```ts cordis-catalog
/**
 * Describe every registered namespace for a configuration page: redacted
 * layered values plus the serialized schema the page renders its form from.
 * @returns provider writability, local-document presence, and one view per namespace.
 * @throws RemoteError when no settings provider is mounted.
 */
@Remote describe(): SettingsDescribeValue

/**
 * Merge a patch into one namespace's stored user section.
 * @param ns - namespace key to write.
 * @param patch - fields to merge into the user section.
 * @param expectedRevision - revision the caller read; `undefined` writes unconditionally.
 * @returns the namespace's redacted view after the write.
 * @throws RemoteError when the request is invalid, no provider is mounted, or the provider refuses the write.
 */
@Remote update( ns: string, patch: Record<string, JsonValue>, expectedRevision: number | undefined, ): Promise<SettingsNamespaceView>

/**
 * Replace one namespace's stored user section wholesale.
 * @param ns - namespace key to write.
 * @param section - complete replacement user section.
 * @param expectedRevision - revision the caller read; `undefined` writes unconditionally.
 * @returns the namespace's redacted view after the write.
 * @throws RemoteError when the request is invalid, no provider is mounted, or the provider refuses the write.
 */
@Remote replace( ns: string, section: Record<string, JsonValue>, expectedRevision: number | undefined, ): Promise<SettingsNamespaceView>

/**
 * Apply path-addressed edits to one namespace's user section, resolved against
 * the section as stored rather than against whatever the caller last read,
 * then answer with that namespace's new redacted view.
 * @param ns - namespace key to write.
 * @param ops - the edits to apply, in order.
 * @param expectedRevision - revision the caller read; `undefined` writes unconditionally.
 * @returns the namespace's redacted view after the write.
 * @throws RemoteError when the request is invalid, no provider is mounted, or the provider refuses the write.
 */
@Remote async mutate( ns: string, ops: SettingsPathOpView[], expectedRevision: number | undefined, ): Promise<SettingsNamespaceView>

/**
 * Materialize the provider-owned settings document and open it in a native text editor.
 * @param signal - caller lifetime; abort terminates preparation or the native command.
 * @returns confirmation after the native opener accepts the document.
 * @throws RemoteError when no document exists, preparation fails, or opening fails.
 */
@Remote async openSettingsDocument(signal: AbortSignal): Promise<SettingsDocumentOpenValue>
```

Source: [`packages/api/settings-controller/src/index.ts`](../../packages/api/settings-controller/src/index.ts)

<a id="accounts-events"></a>

### `accounts/*` events

<a id="accountsauto-switched--emit"></a>

#### `accounts/auto-switched` — emit

Report one committed automatic Codex account promotion.

```ts cordis-catalog
/**
 * Report one committed automatic Codex account promotion.
 * @param event - secret-free source, destination, quota, and timestamp facts.
 * @mode emit
 */
'accounts/auto-switched'(event: AccountAutoSwitchEvent): void
```

Source: [`packages/api/settings-controller/src/types.ts`](../../packages/api/settings-controller/src/types.ts)

<a id="settings-events"></a>

### `settings/*` events

<a id="settingsdocument-updated--emit"></a>

#### `settings/document-updated` — emit

One profile entry's form values, availability, or page policy changed. Form clients re-read its schema, resolved values, and revision.

```ts cordis-catalog
/**
 * One profile entry's form values, availability, or page policy changed.
 * Form clients re-read its schema, resolved values, and revision.
 * @param ns Profile entry id.
 * @param revision The entry's new revision.
 * @mode emit
 */
'settings/document-updated'(ns: SettingsNamespace, revision: number): void
```

Source: [`packages/settings/settings/src/types.ts`](../../packages/settings/settings/src/types.ts)
<!-- END GENERATED cordis-surface -->
