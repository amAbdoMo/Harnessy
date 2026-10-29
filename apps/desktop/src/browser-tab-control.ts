/** Chat-owned tab actions and immediate human handoff, following T3 Code's SessionControl semantics. */
export class BrowserTabControl {
  private tail: Promise<void> = Promise.resolve()
  private epoch = 0
  private human = false
  private humanReady = false
  private closed = false

  /** @param sessionId - owning chat, or null for an unclaimed manual tab. */
  constructor(readonly sessionId: string | null) {}

  /** Current control generation; changes fence already queued agent actions. */
  get generation(): number { return this.epoch }
  /** Whether the human has taken control independently from the owning chat. */
  get humanControl(): boolean { return this.human }
  /** Human input is admitted only after the prior agent action queue has drained. */
  get humanMayAct(): boolean { return this.human && this.humanReady && !this.closed }

  /** @param sessionId - initiating chat. @returns whether this tab is owned by it or unclaimed. */
  mayAct(sessionId: string): boolean { return this.sessionId === null || this.sessionId === sessionId }

  /** @param sessionId - initiating chat. @param run - native action, retained until physical settlement.
   * @returns the action result; queued work is refused after handoff, closure or another generation.
   */
  act<T>(sessionId: string, run: () => Promise<T>): Promise<T> {
    this.assertAgent(sessionId)
    const generation = this.epoch
    const action = this.tail.then(async () => {
      this.assertAgent(sessionId)
      if (generation !== this.epoch) throw new Error('Browser control changed before this action started')
      return run()
    })
    this.tail = action.then(() => {}, () => {})
    return action
  }

  /** @param run - read-only native observation, independent from the action queue. @returns current page observation. */
  observe<T>(run: () => Promise<T>): Promise<T> {
    if (this.closed) throw new Error('Browser tab is closed')
    return run()
  }

  /** @param human - requested controller. @returns after already running actions have settled. */
  async control(human: boolean): Promise<void> {
    if (this.closed) throw new Error('Browser tab is closed')
    if (this.human !== human) { this.human = human; this.humanReady = false; this.epoch++ }
    const epoch = this.epoch
    await this.tail
    if (epoch === this.epoch && this.human) this.humanReady = true
  }

  /** Fence future actions immediately and join current native work. */
  async close(): Promise<void> {
    this.closed = true
    this.epoch++
    await this.tail
  }

  private assertAgent(sessionId: string): void {
    if (this.closed) throw new Error('Browser tab is closed')
    if (!this.mayAct(sessionId)) throw new Error('This browser tab belongs to another chat')
    if (this.human) throw new Error('A human controls this browser tab; resume the agent to act')
  }
}
