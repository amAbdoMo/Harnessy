/** Locale namespace owned by the Workspace Brief client package. */
export const NS = 'workspaceBrief'

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'card.title': '工作区简报',
  'card.running': '正在读取已选工作区…',
  'card.failed': '无法创建工作区简报',
  'markdown.copy': '复制代码',
  'markdown.copied': '已复制',
  'markdown.footnotes': '脚注',
} satisfies Record<string, string>

/** Copy keys shared by both Workspace Brief dictionaries. */
export type WorkspaceBriefKey = keyof typeof zh

/** English dictionary, checked complete against the zh key set. */
export const en = {
  'card.title': 'Workspace Brief',
  'card.running': 'Reading the selected workspace…',
  'card.failed': 'Could not create workspace brief',
  'markdown.copy': 'Copy code',
  'markdown.copied': 'Copied',
  'markdown.footnotes': 'Footnotes',
} satisfies Record<WorkspaceBriefKey, string>
