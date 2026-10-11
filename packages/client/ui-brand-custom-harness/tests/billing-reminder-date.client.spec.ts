import { describe, expect, it } from 'vitest'
import { billingDateLabel, billingToday, nextBillingDate, validBillingDate } from '../src/client/billing-reminder-date.ts'

describe('monthly billing reminder dates', () => {
  it.each([
    ['2026-10-17', '2026-10-16', '2026-10-17'],
    ['2026-10-17', '2026-10-17', '2026-11-17'],
    ['2026-10-17', '2028-03-16', '2028-03-17'],
    ['2026-10-17', '2028-03-17', '2028-04-17'],
    ['2026-12-17', '2026-12-17', '2027-01-17'],
    ['2026-01-31', '2026-01-31', '2026-02-28'],
    ['2026-01-31', '2026-02-28', '2026-03-31'],
    ['2028-01-31', '2028-01-31', '2028-02-29'],
    ['2028-01-31', '2028-02-29', '2028-03-31'],
    ['2026-01-30', '2026-02-28', '2026-03-30'],
    ['2026-01-29', '2026-02-28', '2026-03-29'],
    ['2099-01-31', '2100-02-27', '2100-02-28'],
    ['2399-01-31', '2400-02-28', '2400-02-29'],
    ['2026-03-31', '2026-02-01', '2026-03-31'],
    ['0001-01-31', '2026-09-30', '2026-10-31'],
    ['0099-12-31', '0100-01-30', '0100-01-31'],
    ['9999-12-31', '9999-12-30', '9999-12-31'],
  ])('derives %s after local day %s as %s', (anchor, today, expected) => {
    expect(nextBillingDate(anchor, today)).toBe(expected)
  })

  it('has no future occurrence when unset or beyond the supported final month', () => {
    expect(nextBillingDate(undefined, '2026-10-17')).toBeUndefined()
    expect(nextBillingDate('9999-12-31', '9999-12-31')).toBeUndefined()
    expect(nextBillingDate('9999-12-17', '9999-12-17')).toBeUndefined()
    expect(nextBillingDate('2026-10-17', '10000-01-01')).toBeUndefined()
  })

  it.each(['0001-01-01', '0099-02-28', '2000-02-29', '2400-02-29', '9999-12-31'])('accepts %s', (date) => {
    expect(validBillingDate(date)).toBe(true)
  })

  it.each(['', '0000-01-01', '2026-02-29', '2100-02-29', '2026-04-31', '2026-13-01', '10000-01-01', '2026-01-01T00:00:00Z']) (
    'rejects %s rather than normalizing it', (date) => { expect(validBillingDate(date)).toBe(false) },
  )

  it('uses the local calendar sample', () => {
    const local = new Date(2026, 9, 17, 0, 0).getTime()
    expect(billingToday(local)).toBe('2026-10-17')
  })

  it.each([
    ['2026-10-17', 'en-US', 'Oct 17'],
    ['2026-02-28', 'en-US', 'Feb 28'],
    ['0001-01-01', 'en-US', 'Jan 1'],
    ['0099-02-28', 'en-US', 'Feb 28'],
    ['2026-10-17', 'zh-CN', '10月17日'],
    ['2026-02-28', 'zh-CN', '2月28日'],
    ['0001-01-01', 'zh-CN', '1月1日'],
    ['0099-02-28', 'zh-CN', '2月28日'],
  ])('displays %s in %s as %s without a year or timezone shift', (date, locale, expected) => {
    expect(billingDateLabel(date, locale)).toBe(expected)
  })
})
