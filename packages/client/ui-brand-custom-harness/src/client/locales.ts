/** English Custom Harness identity copy. */
export const en = {
  aboutLabel: 'About Custom Harness',
  aboutTitle: 'About Custom Harness',
  aboutSummary: 'An independent local workspace for agent-assisted software work.',
  heroTagline: 'A focused workspace for planning, building, and verifying software.',
  product: 'Product',
  version: 'Version',
  projectLink: 'Project repository',
  supportLink: 'Support and issues',
} as const

/** Custom Harness identity dictionary key. */
export type BrandKey = keyof typeof en

/** Chinese Custom Harness identity copy. */
export const zh: { [Key in BrandKey]: string } = {
  aboutLabel: '关于 Custom Harness',
  aboutTitle: '关于 Custom Harness',
  aboutSummary: '用于智能体辅助软件工作的独立本地工作空间。',
  heroTagline: '用于规划、构建和验证软件的专注工作空间。',
  product: '产品',
  version: '版本',
  projectLink: '项目仓库',
  supportLink: '支持与问题反馈',
}
