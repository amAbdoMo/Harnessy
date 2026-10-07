/** Local wall-clock updates for quota countdowns and reset expiry eligibility. */
import { useEffect, useState } from 'react'

const USAGE_CLOCK_INTERVAL_MS = 30_000

/**
 * Sample time while a visible usage surface needs live dates.
 * @param enabled - whether countdowns or credit expiry depend on current time.
 * @returns the latest wall-clock sample.
 */
export function useUsageClock(enabled: boolean): number {
  const [nowMs, setNowMs] = useState(Date.now)
  useEffect(() => {
    if (!enabled) return
    const update = (): void => { setNowMs(Date.now()) }
    update()
    const timer = window.setInterval(update, USAGE_CLOCK_INTERVAL_MS)
    window.addEventListener('focus', update)
    document.addEventListener('visibilitychange', update)
    return () => {
      window.clearInterval(timer)
      window.removeEventListener('focus', update)
      document.removeEventListener('visibilitychange', update)
    }
  }, [enabled])
  return nowMs
}
