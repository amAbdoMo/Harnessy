/**
 * Copy projection for the Desktop update surfaces: the active `settings`
 * dictionary owns every visible and accessible string, and a shell value that
 * crosses the preload boundary is clamped instead of trusted.
 */
import { describe, expect, it } from 'vitest'
import {
  desktopUpdateCopy, type SettingsTranslate, updateBytesText, updatePercent, updateVisible,
} from '../src/client/desktop-update-copy.ts'
import { en, zh } from '../src/client/locales.ts'

function translate(dictionary: typeof zh | typeof en): SettingsTranslate {
  const messages: Readonly<Record<string, string>> = dictionary
  return (key, params) => Object.entries(params ?? {})
    .reduce((message, [name, value]) => message.replaceAll(`{${name}}`, String(value)), messages[key] ?? key)
}

const t = translate(zh)

describe('update progress values', () => {
  it('clamps a missing or out-of-range shell percentage', () => {
    expect(updatePercent({ phase: 'downloading' })).toBe(0)
    expect(updatePercent({ phase: 'downloading', percent: 58.4 })).toBe(58)
    expect(updatePercent({ phase: 'downloading', percent: 140 })).toBe(100)
    expect(updatePercent({ phase: 'downloading', percent: -20 })).toBe(0)
  })

  it('renders whichever transfer counts the shell reported', () => {
    expect(updateBytesText({ phase: 'downloading' })).toBeUndefined()
    expect(updateBytesText({ phase: 'downloading', transferredBytes: 4_404_019 })).toBe('4.2MB')
    expect(updateBytesText({ phase: 'downloading', totalBytes: 12_582_912 })).toBe('12MB')
    expect(updateBytesText({ phase: 'downloading', transferredBytes: 4_404_019, totalBytes: 12_582_912 }))
      .toBe('4.2MB / 12MB')
  })
})

describe('update visibility', () => {
  it('paints for a failed carrier and for every phase but idle', () => {
    expect(updateVisible({ failed: true })).toBe(true)
    expect(updateVisible({ failed: false, presentation: { phase: 'idle' } })).toBe(false)
    expect(updateVisible({ failed: false })).toBe(false)
    expect(updateVisible({ failed: false, presentation: { phase: 'waiting' } })).toBe(true)
  })
})

describe('update copy', () => {
  it('falls back to the retry wording for a carrier that failed', () => {
    expect(desktopUpdateCopy(undefined, true, t)).toEqual({ label: '重试更新', detail: '重试更新' })
    expect(desktopUpdateCopy({ phase: 'ready', version: '1.0.1' }, true, t))
      .toEqual({ label: '重试更新', detail: '重试更新' })
  })

  it('stays empty without a state and while idle', () => {
    expect(desktopUpdateCopy(undefined, false, t)).toEqual({ label: '', detail: '' })
    expect(desktopUpdateCopy({ phase: 'idle' }, false, t)).toEqual({ label: '', detail: '' })
  })

  it('names every phase, with the version detail when the shell reports one', () => {
    const phases = {
      checking: '正在检查更新…',
      available: '新版本',
      verifying: '正在校验更新文件…',
      ready: '安装并重启',
      installing: '正在准备重启…',
    } as const
    for (const [phase, label] of Object.entries(phases)) {
      expect(desktopUpdateCopy({ phase: phase as keyof typeof phases }, false, t))
        .toEqual({ label, detail: label })
      expect(desktopUpdateCopy({ phase: phase as keyof typeof phases, version: '1.0.1' }, false, t))
        .toEqual({ label, detail: `${label} — V1.0.1` })
    }
    // A staged restart explains the schedule rather than repeating its label.
    expect(desktopUpdateCopy({ phase: 'waiting' }, false, t))
      .toEqual({ label: '等待安装', detail: '任务结束后将自动安装并重启' })
    expect(desktopUpdateCopy({ phase: 'waiting', version: '1.0.1' }, false, t))
      .toEqual({ label: '等待安装', detail: '任务结束后将自动安装并重启 — V1.0.1' })
  })

  it('carries the live percentage through the download label and detail', () => {
    expect(desktopUpdateCopy({ phase: 'downloading', percent: 58 }, false, t))
      .toEqual({ label: '正在下载更新：58%', detail: '正在下载更新：58%' })
    expect(desktopUpdateCopy({ phase: 'downloading', version: '1.0.1', percent: 58 }, false, t))
      .toEqual({ label: '正在下载更新：58%', detail: '正在下载更新：58%\n目标版本：V1.0.1' })
  })

  it('maps every classified failure to its own guidance', () => {
    const failures = {
      check: '检查更新失败，请稍后重试。',
      'check-network': '检查更新失败，请稍后重试。网络连接异常，请检查网络后重试。',
      download: '下载更新失败，请重试。',
      'download-network': '下载更新失败，请重试。网络连接异常，请检查网络后重试。',
      verify: '更新文件校验失败，请重试。',
      disk: '磁盘空间不足，请清理后重试。',
      revoked: '该版本已撤回，请检查更新。',
      install: '安装更新失败，请稍后重试。',
      'install-network': '安装更新失败，请稍后重试。网络连接异常，请检查网络后重试。',
      'stop-failed': '未能安全停止任务，更新未安装。请稍后重试。',
      'tasks-changed': '有新任务开始，请重新确认更新。',
      'tasks-unavailable': '无法确认任务状态，请在工作区就绪后重试更新。',
    } as const
    for (const [failure, detail] of Object.entries(failures)) {
      expect(desktopUpdateCopy({ phase: 'error', failure: failure as keyof typeof failures }, false, t))
        .toEqual({ label: '重试更新', detail })
    }
  })

  it('resolves the same state through the active locale', () => {
    const english = translate(en)
    expect(desktopUpdateCopy({ phase: 'ready', version: '1.0.1' }, false, english))
      .toEqual({ label: 'Install and Restart', detail: 'Install and Restart — V1.0.1' })
    expect(desktopUpdateCopy({ phase: 'error', failure: 'disk' }, false, english))
      .toEqual({ label: 'Retry update', detail: 'Not enough disk space. Free some space and try again.' })
  })
})
