/** Session log and projection declarations for current-chat Codex priority. */
export {}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * Whole current-chat Codex priority preference; log-only QoS, never model history.
     * Producers append with `ignorable: true` so readers without this plugin can reopen the chat.
     * @param enabled - whether subsequent Codex conversation requests ask for priority service.
     */
    'llm-pi-ai/fast-mode': { enabled: boolean }
  }
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    /** Saved current-chat Codex priority preference, not provider acceptance or speed. */
    codexFastMode: boolean
  }

  interface SessionProjectionStateMap {
    /** Current-chat Codex priority preference; absent until its owner registers. */
    codexFastMode: boolean
  }
}
