/** Local-day updates for recurring reminders, without quota polling or Host writes. */
import { useEffect, useState } from 'react'
import { billingToday } from './billing-reminder-date.ts'

/**
 * Sample the local date on entry, midnight, and foreground return.
 * @param enabled - whether a saved monthly reminder needs date updates.
 * @returns current browser-local YYYY-MM-DD.
 */
export function useBillingDay(enabled: boolean): string {
  const [today, setToday] = useState(() => billingToday(Date.now()))
  useEffect(() => {
    if (!enabled) return
    let timer: ReturnType<typeof window.setTimeout> | undefined
    const update = (): void => {
      window.clearTimeout(timer)
      const now = Date.now()
      setToday(billingToday(now))
      const midnight = new Date(now)
      midnight.setHours(24, 0, 0, 0)
      timer = window.setTimeout(update, Math.max(1, midnight.getTime() - now))
    }
    update()
    window.addEventListener('focus', update)
    document.addEventListener('visibilitychange', update)
    return () => {
      window.clearTimeout(timer)
      window.removeEventListener('focus', update)
      document.removeEventListener('visibilitychange', update)
    }
  }, [enabled])
  return today
}
