/** Request transport double for Browser tests that exercise navigation rather than Agent handoff. */
import { vi } from 'vitest'
import type { DesktopWebsiteRequestsBridge } from '../src/types.ts'

/** @returns isolated spies; unexpected grant or guest-association attempts fail instead of granting a mock permission. */
export function requestStubs(): DesktopWebsiteRequestsBridge {
  return {
    list: vi.fn(async () => []),
    prepare: vi.fn(async () => { throw new Error('Unexpected request preparation in navigation fixture') }),
    visible: vi.fn(async () => undefined),
    acknowledge: vi.fn(async () => {}),
    resume: vi.fn(async () => { throw new Error('Unexpected request Resume in navigation fixture') }),
    takeover: vi.fn(async () => {}),
    onChanged: vi.fn(() => () => {}),
  }
}
