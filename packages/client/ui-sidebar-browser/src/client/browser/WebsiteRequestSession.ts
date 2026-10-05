/** Session-local request roster; native identities belong to pages and never to the globally selected Session. */
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { DesktopWebsiteHostSnapshot, DesktopWebsiteProfileId, DesktopWebsiteRequestId, DesktopWebsiteRequestsBridge } from '../../types.ts'
import { WebsiteRequestPage, type WebsiteRequestPageOwner, type WebsiteRequestPageState } from './WebsiteRequestPage.ts'

/** Follows captured Host requests only while the initiating Session has a saved-profile page. */
export class WebsiteRequestSession implements WebsiteRequestPageOwner {
  private readonly pages = new Set<WebsiteRequestPage>()
  private readonly claims = new Map<DesktopWebsiteRequestId, WebsiteRequestPage>()
  private rows: readonly DesktopWebsiteHostSnapshot[] = []
  private phase: WebsiteRequestPageState['phase'] = 'loading'
  private unsubscribe: (() => void) | undefined
  private refresh: Promise<void> | undefined
  private dirty = false
  private generation = 0
  private closed = false
  private disposal: Promise<void> | undefined

  /**
   * @param sessionId - captured initiating Session.
   * @param bridge - request-only transport.
   * @param report - frame-wide settled feedback.
   */
  constructor(readonly sessionId: Branded<'SessionId'>, readonly bridge: DesktopWebsiteRequestsBridge,
    readonly report: WebsiteRequestPageOwner['report']) {}

  /**
   * Create an account-bound page and follow requests owned by this initiating Session.
   * @param profile - page's immutable account.
   * @returns a new explicit-selection page control.
   */
  createPage(profile: DesktopWebsiteProfileId): WebsiteRequestPage {
    if (this.closed) throw new Error('Website request Session is closed')
    const page = new WebsiteRequestPage(this, profile)
    this.pages.add(page)
    if (this.unsubscribe === undefined) {
      this.generation++
      this.phase = 'loading'
      this.rows = []
      this.unsubscribe = this.bridge.onChanged(() => { void this.reload() })
      void this.reload()
    }
    page.update(this.phase, this.rows)
    return page
  }

  /** @param id - explicit selection. @param page - page occurrence making it. @returns whether no other page owns this request. */
  claim(id: DesktopWebsiteRequestId, page: WebsiteRequestPage): boolean {
    if (this.closed || !this.pages.has(page)) return false
    const owner = this.claims.get(id)
    if (owner !== undefined) return owner === page
    if (this.claims.size >= 128) return false
    this.claims.set(id, page)
    return true
  }

  /** @param id - safely deselected or retired request. @param page - original claim owner. */
  unclaim(id: DesktopWebsiteRequestId, page: WebsiteRequestPage): void {
    if (this.claims.get(id) === page) this.claims.delete(id)
  }

  /** @param page - drained page; failed cleanup must not call this. */
  release(page: WebsiteRequestPage): void {
    this.pages.delete(page)
    for (const [id, owner] of this.claims) if (owner === page) this.claims.delete(id)
    if (this.pages.size !== 0) return
    this.unsubscribe?.()
    this.unsubscribe = undefined
    this.generation++
    this.dirty = false
    this.rows = []
  }

  /** @returns after coalesced Session reads settle; failures retain the usable rows without granting access. */
  reload(): Promise<void> {
    if (this.closed || this.pages.size === 0) return Promise.resolve()
    this.dirty = true
    if (this.refresh !== undefined) return this.refresh
    const completion = Promise.withResolvers<void>()
    this.refresh = completion.promise
    void this.read().then(() => {
      this.refresh = undefined
      if (this.dirty && !this.closed && this.pages.size !== 0) {
        void this.reload().then(completion.resolve, completion.reject)
      } else completion.resolve()
    }, (error: unknown) => {
      this.refresh = undefined
      completion.reject(error)
    })
    return completion.promise
  }

  /**
   * Stop roster observation and drain all owned pages.
   * @returns after every page and owned roster read settles; failed cleanup retains its owner.
   */
  dispose(): Promise<void> {
    if (this.disposal !== undefined) return this.disposal
    this.closed = true
    this.unsubscribe?.()
    this.unsubscribe = undefined
    this.generation++
    this.dirty = false
    this.disposal = Promise.allSettled([...this.pages].map(page => page.dispose())).then(async (results) => {
      await this.refresh
      const failures = results.filter(result => result.status === 'rejected').map((result): unknown => result.reason)
      if (failures.length !== 0) throw new AggregateError(failures, 'Website request pages failed to drain')
    })
    return this.disposal
  }

  private async read(): Promise<void> {
    while (this.dirty && !this.closed && this.pages.size !== 0) {
      this.dirty = false
      const generation = this.generation
      try {
        const rows = await this.bridge.list(this.sessionId)
        // reload() can invalidate this read while its IPC promise is pending.
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
        if (generation !== this.generation || this.dirty) continue
        if (rows.length > 128 || rows.some(row => row.sessionId !== this.sessionId)) {
          throw new Error('Website request roster is outside its Session bounds')
        }
        this.rows = rows
        this.phase = 'ready'
      } catch (error) {
        // reload() can invalidate this read while its IPC promise is pending.
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
        if (generation !== this.generation || this.dirty) continue
        this.phase = 'failed'
        // The request bar offers Retry without displaying transport details or page observations.
        void error
      }
      for (const page of this.pages) page.update(this.phase, this.rows)
    }
  }
}
