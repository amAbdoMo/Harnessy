/** Browser-specific annotation glyphs, aligned with the compact navigation icons. */
import type { ReactNode } from 'react'
import { ICON_REGULAR_STROKE } from '@deepseek-ai/dsh-client-ui-primitives'

const PATHS = {
  select: 'M3 2.5 12.5 8 8 9.5 6.5 14Z M8 9.5 11 13',
  region: 'M6 2.5H3.5a1 1 0 0 0-1 1V6 M10 2.5h2.5a1 1 0 0 1 1 1V6 M13.5 10v2.5a1 1 0 0 1-1 1H10 M6 13.5H3.5a1 1 0 0 1-1-1V10',
  draw: 'm10.5 2.5 3 3-8 8-3 .5.5-3Z M8.5 4.5l3 3',
  erase: 'm6 12.5-3.5-3.5a1 1 0 0 1 0-1.5L8 2a1 1 0 0 1 1.5 0l4 4a1 1 0 0 1 0 1.5l-5 5H6Z M5.5 4.5l6 6 M6 12.5h8',
  undo: 'M5.5 3 2 6.5 5.5 10 M2 6.5h7a4 4 0 0 1 0 8',
} as const

/** @param props - annotation action to depict. @returns a decorative, current-color glyph. */
export function BrowserAnnotationIcon({ tool }: { readonly tool: keyof typeof PATHS }): ReactNode {
  return <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"
    stroke="currentColor" strokeWidth={ICON_REGULAR_STROKE} strokeLinecap="round" strokeLinejoin="round">
    <path d={PATHS[tool]} />
  </svg>
}
