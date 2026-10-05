/** `approval` namespace dictionaries. */

/** Simplified Chinese dictionary and key-set source of truth. */
export const zh = {
  waiting: '等待审批',
  'detail.aria': '审批详情',
  escalation: '工具 {toolName} 请求越权执行',
  reject: '拒绝',
  allowOnce: '允许一次',
  'checkpoint.title': '审批：{toolName}',
  'checkpoint.asked': '已请求权限',
  'checkpoint.allowed-once': '已授予一次权限',
  'checkpoint.rejected': '已拒绝',
  'checkpoint.cancelled': '已取消',
  'checkpoint.unavailable': '审批不可用',
} satisfies Record<string, string>

/** Approval dictionary key union. */
export type ApprovalKey = keyof typeof zh

/** English dictionary, checked against the Chinese key set. */
export const en = {
  waiting: 'Waiting for approval',
  'detail.aria': 'Approval details',
  escalation: 'Tool {toolName} requests privileged execution',
  reject: 'Reject',
  allowOnce: 'Allow once',
  'checkpoint.title': 'Approval: {toolName}',
  'checkpoint.asked': 'Permission requested',
  'checkpoint.allowed-once': 'Permission granted once',
  'checkpoint.rejected': 'Rejected',
  'checkpoint.cancelled': 'Cancelled',
  'checkpoint.unavailable': 'Approval unavailable',
} satisfies Record<ApprovalKey, string>
