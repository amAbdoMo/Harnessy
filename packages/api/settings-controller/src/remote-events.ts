/** Select the account-manager event that the application Remote forwards. */

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface TypertRemoteEventSelection extends Record<'accounts/auto-switched', true> {}
}

export {}
