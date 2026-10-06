/** Select the redacted account-manager events that the application Remote forwards. */

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface TypertRemoteEventSelection extends Record<'accounts/auto-switched' | 'accounts/changed', true> {}
}

export {}
