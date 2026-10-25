/** Locale-owned application-access approval messages. */
/** English application-access messages. */
export const en = {
  question: 'Allow computer use to launch, read, capture and control this application?',
  detail: 'Session access lasts until DSH restarts or computer use is disabled.',
  approve: 'Allow for this session',
}
/** Chinese application-access messages. */
export const zh = {
  question: '允许 Computer Use 启动、读取、截图和控制此应用吗？',
  detail: '会话授权在 DSH 重启或关闭 Computer Use 后失效。',
  approve: '本会话允许',
} satisfies Record<keyof typeof en, string>
/** Display translations resolved by the Client; wire choices stay unchanged. */
export const applicationAccessDisplay = {
  question: {
    en: en.question,
    zh: zh.question,
  },
  detail: { en: en.detail, zh: zh.detail },
  approve: {
    en: en.approve,
    zh: zh.approve,
  },
}
