/** Visual severity shared by full and compact account usage meters. */
export type AccountUsageLevel = 'normal' | 'warning' | 'danger'

/**
 * Classify quota consumption for the shared meter palette.
 * @param usedPercent - provider-reported quota consumption from zero to one hundred.
 * @returns normal below 80%, warning from 80%, and danger from 95%.
 */
export function accountUsageLevel(usedPercent: number): AccountUsageLevel {
  if (usedPercent >= 95) return 'danger'
  return usedPercent >= 80 ? 'warning' : 'normal'
}
