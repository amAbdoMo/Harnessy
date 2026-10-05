/** Desktop saved-website-profile state shared by every Browser occurrence. */
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type {
  DesktopWebsiteProfile, DesktopWebsiteProfileId, DesktopWebsiteProfileInput, DesktopWebsiteProfilesBridge,
} from '../../types.ts'

/** A settled saved-profile action the Browser chrome announces. */
export type WebsiteProfileNotice =
  | { readonly kind: 'created'; readonly seq: number; readonly name: string }
  | { readonly kind: 'resumed'; readonly seq: number; readonly name: string }
  | { readonly kind: 'human'; readonly seq: number; readonly name: string }
  | { readonly kind: 'signedOut'; readonly seq: number; readonly name: string }
  | { readonly kind: 'forgotten'; readonly seq: number; readonly name: string }
  | { readonly kind: 'failed'; readonly seq: number }
  | { readonly kind: 'requestFailed'; readonly seq: number }

/** Everything the picker, the profile bar, and the notice overlay read. */
export interface WebsiteProfilesState {
  /** `loading` until the first read lands; `failed` keeps the last usable list. */
  readonly phase: 'loading' | 'ready' | 'failed'
  readonly profiles: readonly DesktopWebsiteProfile[]
  /** Account whose action is in flight; every other action stays disabled meanwhile. */
  readonly busy: DesktopWebsiteProfileId | undefined
  /** Whether a create request is in flight; an unsaved account has no identity to mark. */
  readonly creating: boolean
  /** Latest settled action, until its notice is dismissed. */
  readonly notice: WebsiteProfileNotice | null
}

/** Saved-profile operations; Resume belongs to the selected request, while account Takeover also revokes aliases. */
export interface WebsiteProfileCommands {
  /**
   * Save a user-confirmed pairing; the account starts under human control.
   * @param input - name, account label, site address, and MCP server name.
   * @returns the saved profile, or undefined when the request failed and published its notice.
   */
  create(this: void, input: DesktopWebsiteProfileInput): Promise<DesktopWebsiteProfile | undefined>
  /** @param profile - account whose reservations, including aliases, are revoked without clearing sign-in data. */
  takeover(this: void, profile: DesktopWebsiteProfileId): Promise<void>
  /** @param profile - account whose guests close and whose sign-in data is cleared; the saved pairing stays. */
  signOut(this: void, profile: DesktopWebsiteProfileId): Promise<void>
  /** @param profile - account cleared and then removed; a failed cleanup keeps it saved. */
  forget(this: void, profile: DesktopWebsiteProfileId): Promise<void>
  /** Read the saved list again after a failed read. */
  reload(this: void): Promise<void>
  /** Take the current notice down. */
  dismiss(this: void): void
}

/** One model per plugin instance, shared by every tab occurrence and the notice overlay. */
export interface WebsiteProfilesModel {
  /** Observably stable source for the registration hooks compartment. */
  readonly source: HostObservable<WebsiteProfilesState>
  /** Complete mutation API; the UI never reaches the desktop bridge itself. */
  readonly commands: WebsiteProfileCommands
  /** @param profile - requesting page's saved account. @param outcome - settled request-only action. */
  reportRequest(profile: DesktopWebsiteProfileId, outcome: 'resumed' | 'human' | 'requestFailed'): void
  /** Stop following main-process changes and join owned IPC; the plugin is unloading. */
  dispose(): Promise<void>
}

/**
 * Track the desktop saved-profile registry on behalf of every Browser occurrence.
 *
 * Reads publish only from the newest request. Mutations run in call order and
 * publish settled feedback through the frame-wide notice overlay. Disposal
 * suppresses late publication, prevents queued IPC, and joins started calls.
 * @param profiles - main-process profile operations.
 * @returns the shared state source, its commands, and the subscription disposer.
 */
export function createWebsiteProfilesModel(profiles: DesktopWebsiteProfilesBridge): WebsiteProfilesModel {
  const store = createSnapshotStore<WebsiteProfilesState>({
    phase: 'loading', profiles: [], busy: undefined, creating: false, notice: null,
  })
  const source: HostObservable<WebsiteProfilesState> = {
    getSnapshot: () => store.getSnapshot(),
    subscribe: listener => store.subscribe(listener),
  }
  let sequence = 0
  let revision = 0
  let queue: Promise<void> = Promise.resolve()
  let disposed = false
  const pendingCalls = new Set<Promise<unknown>>()
  const track = <T>(pending: Promise<T>): Promise<T> => {
    pendingCalls.add(pending)
    void pending.then(() => { pendingCalls.delete(pending) }, () => { pendingCalls.delete(pending) })
    return pending
  }

  const publish = (next: Partial<WebsiteProfilesState>): void => {
    if (!disposed) store.set({ ...store.getSnapshot(), ...next })
  }
  const announce = (notice: WebsiteProfileNotice): void => { publish({ notice }) }
  const nameOf = (profile: DesktopWebsiteProfileId): string =>
    store.getSnapshot().profiles.find(candidate => candidate.id === profile)?.name ?? ''

  const read = async (): Promise<void> => {
    if (disposed) return
    const current = ++revision
    try {
      const listed = await profiles.list()
      if (current === revision) publish({ phase: 'ready', profiles: listed })
    } catch (error) {
      // Failed reads retain the list and expose Retry rather than transport details.
      void error
      if (current === revision) publish({ phase: 'failed' })
    }
  }

  /** Queue one mutation; failure reports feedback without losing the saved list. */
  const operate = <T>(profile: DesktopWebsiteProfileId | undefined, work: () => Promise<T>,
    notice: (result: T) => WebsiteProfileNotice): Promise<T | undefined> => {
    const run = async (): Promise<T | undefined> => {
      if (disposed) return undefined
      publish(profile === undefined ? { creating: true } : { busy: profile })
      try {
        const result = await work()
        // dispose() can close the model while the mutation IPC is pending.
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
        if (disposed) return undefined
        await read()
        // dispose() can close the model during the awaited list IPC.
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
        if (disposed) return undefined
        announce(notice(result))
        return result
      } catch (error) {
        // dispose() can close the model while the mutation IPC is pending.
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
        if (disposed) return undefined
        await read()
        // Main-process diagnostics can contain account data; only a generic outcome reaches the UI.
        void error
        // dispose() can close the model during the awaited list IPC.
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
        if (!disposed) announce({ kind: 'failed', seq: ++sequence })
        return undefined
      } finally {
        publish(profile === undefined ? { creating: false } : { busy: undefined })
      }
    }
    const pending = queue.then(run)
    queue = pending.then(() => {}, () => {})
    return track(pending)
  }

  const act = (profile: DesktopWebsiteProfileId, work: () => Promise<void>,
    kind: 'human' | 'signedOut' | 'forgotten'): Promise<void> => {
    const name = nameOf(profile)
    return operate(profile, work, () => ({ kind, seq: ++sequence, name }))
  }

  const commands: WebsiteProfileCommands = {
    create: input => operate(undefined, () => profiles.create(input),
      created => ({ kind: 'created', seq: ++sequence, name: created.name })),
    takeover: profile => act(profile, () => profiles.setControl(profile, 'human'), 'human'),
    signOut: profile => act(profile, () => profiles.signOut(profile), 'signedOut'),
    forget: profile => act(profile, () => profiles.forget(profile), 'forgotten'),
    reload: async () => { publish({ phase: 'loading' }); await track(read()) },
    dismiss: () => { publish({ notice: null }) },
  }
  const unsubscribe = profiles.onChanged(() => { void track(read()) })
  void track(read())
  return { source, commands, reportRequest: (profile, outcome) => {
    if (disposed) return
    announce(outcome === 'requestFailed'
      ? { kind: outcome, seq: ++sequence }
      : { kind: outcome, seq: ++sequence, name: nameOf(profile) })
  }, dispose: async () => {
    disposed = true
    revision++
    unsubscribe()
    await Promise.allSettled([...pendingCalls])
  } }
}

/**
 * Build the selector source for a carrier without the desktop bridge.
 * @returns an unchanging source; no saved profile can exist in that carrier.
 */
export function absentWebsiteProfilesSource(): HostObservable<WebsiteProfilesState> {
  const state: WebsiteProfilesState = { phase: 'ready', profiles: [], busy: undefined, creating: false, notice: null }
  return { getSnapshot: () => state, subscribe: () => () => {} }
}
