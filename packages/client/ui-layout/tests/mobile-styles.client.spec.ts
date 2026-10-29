/** Viewport and touch geometry are CSS contracts; jsdom does not perform layout. */
import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'

const css = readFileSync(new URL('../src/client/AppFrame.module.css', import.meta.url), 'utf8')

function rule(selector: string): string {
  const start = css.indexOf(`\n${selector} {`)
  if (start === -1) throw new Error(`missing mobile layout rule: ${selector}`)
  return css.slice(start, css.indexOf('}', start) + 1)
}

it('fits the phone canvas and portaled navigator to the dynamic viewport and safe areas', () => {
  expect(rule('.frame[data-phone]')).toContain('height: 100dvh')
  for (const selector of ['.frame[data-phone]', '.mobileDialog']) {
    const body = rule(selector)
    for (const edge of ['top', 'right', 'bottom', 'left']) {
      expect(body).toContain(`env(safe-area-inset-${edge})`)
    }
  }
  expect(rule('.mobileDialog')).toContain('width: 100%')
  expect(rule('.mobileDialog')).toContain('max-height: 100%')
  expect(rule('.mobileSidebar')).toContain('overflow: auto')
  expect(rule('.mobileSidebar')).toContain('min-height: 0')
  expect(rule(".mobileSidebar [data-slot='sidebar'] > *")).toContain('width: 100% !important')
})

it('keeps phone navigation and reconnect controls touch-sized without changing desktop height', () => {
  expect(rule('.mobileIconButton')).toContain('min-width: 44px')
  expect(rule('.mobileIconButton')).toContain('min-height: 44px')
  expect(rule('.mobileConnection > button')).toContain('min-height: 44px')
  expect(rule(".mobileSidebar :is(button, input, [role='button'], [role='treeitem'])")).toContain('min-height: 44px')
  expect(rule('.frame')).toContain('height: 100%')
  expect(rule('.mobileIconButton:focus-visible')).toContain('var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary))')
})
