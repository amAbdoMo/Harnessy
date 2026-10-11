/** Date-only monthly occurrences anchored to the user's original calendar day. */

/**
 * Validate a date entered in the reminder form without normalizing invalid days.
 * @param date - form value in YYYY-MM-DD format.
 * @returns whether the date is Gregorian and within years 0001–9999.
 */
export function validBillingDate(date: string): boolean {
  if (date.length !== 10 || !/^\d{4}-\d{2}-\d{2}$/u.test(date) || date.startsWith('0000')) return false
  const parsed = new Date(`${date}T00:00:00Z`)
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date
}

/**
 * Read the browser's local calendar day without converting a saved date to a timestamp.
 * @param nowMs - current wall-clock sample.
 * @returns local YYYY-MM-DD.
 */
export function billingToday(nowMs: number): string {
  const now = new Date(nowMs)
  return `${String(now.getFullYear()).padStart(4, '0')}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
}

function occurrence(year: number, month: number, day: number): string {
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
  const lastDay = month === 2 ? (leap ? 29 : 28) : [4, 6, 9, 11].includes(month) ? 30 : 31
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(Math.min(day, lastDay)).padStart(2, '0')}`
}

/**
 * Derive the first monthly occurrence strictly after today in constant time.
 * The original day survives short-month clamping; the anchor never changes.
 * @param anchor - validated saved YYYY-MM-DD starting date, or no reminder.
 * @param today - current local Gregorian YYYY-MM-DD.
 * @returns next date, or undefined when unset or no occurrence fits through year 9999.
 */
export function nextBillingDate(anchor: string | undefined, today: string): string | undefined {
  if (anchor === undefined || Number(today.split('-')[0]) > 9999) return undefined
  if (anchor > today) return anchor
  let year = Number(today.slice(0, 4))
  let month = Number(today.slice(5, 7))
  const day = Number(anchor.slice(8, 10))
  const candidate = occurrence(year, month, day)
  if (candidate > today) return candidate
  if (month === 12) { year += 1; month = 1 } else month += 1
  return year > 9999 ? undefined : occurrence(year, month, day)
}

/**
 * Display a validated date as day/month/year without locale-dependent timestamp conversion.
 * @param date - YYYY-MM-DD occurrence.
 * @returns DD/MM/YYYY.
 */
export function billingDateLabel(date: string): string {
  return `${date.slice(8, 10)}/${date.slice(5, 7)}/${date.slice(0, 4)}`
}
