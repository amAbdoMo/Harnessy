export const NS = 'workspaceBrief'

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'action.idle': '创建工作区简报',
  'action.loading': '正在创建工作区简报',
  'action.success': '工作区简报已创建',
  'action.failed': '工作区简报创建失败',
  'action.unavailable': '工作区简报命令不可用',
  'card.title': '工作区简报',
  'card.running': '正在读取已选工作区…',
  'card.failed': '无法创建工作区简报',
  'markdown.copy': '复制代码',
  'markdown.copied': '已复制',
  'markdown.footnotes': '脚注',
} satisfies Record<string, string>

export type WorkspaceBriefKey = keyof typeof zh

/** English dictionary, checked complete against the zh key set. */
export const en = {
  'action.idle': 'Create workspace brief',
  'action.loading': 'Creating workspace brief',
  'action.success': 'Workspace brief created',
  'action.failed': 'Workspace brief failed',
  'action.unavailable': 'Workspace Brief command is unavailable',
  'card.title': 'Workspace Brief',
  'card.running': 'Reading the selected workspace…',
  'card.failed': 'Could not create workspace brief',
  'markdown.copy': 'Copy code',
  'markdown.copied': 'Copied',
  'markdown.footnotes': 'Footnotes',
} satisfies Record<WorkspaceBriefKey, string>
