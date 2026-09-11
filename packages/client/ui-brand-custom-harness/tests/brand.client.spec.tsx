// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AboutRow, type AboutRowProps } from '../src/client/AboutRow.tsx'
import {
  CustomHarnessMark, CustomHarnessName, CustomHarnessTagline, type CustomHarnessTaglineProps,
  requiredBuildValue,
} from '../src/client/Brand.tsx'

afterEach(() => {
  cleanup()
  vi.unstubAllEnvs()
})

describe('Harnessy identity components', () => {
  it('uses the app icon for compact seats and the transparent mark for larger seats', () => {
    vi.stubEnv('DSH_CLIENT_ICON_PATH', '/harnessy.png')
    vi.stubEnv('DSH_CLIENT_MARK_PATH', '/harnessy-mark.png')
    const subject = render(<CustomHarnessMark size={24} />)
    const mark = subject.container.querySelector('span')
    const image = subject.container.querySelector('img')
    expect(image?.getAttribute('src')).toBe('/harnessy.png')
    expect(mark?.getAttribute('style')).toContain('width: 24px')
    for (const size of [34, 64]) {
      subject.rerender(<CustomHarnessMark size={size} />)
      expect(subject.container.querySelector('img')?.getAttribute('src')).toBe('/harnessy-mark.png')
      expect(mark?.getAttribute('style')).toContain(`width: ${String(size)}px`)
      expect(mark?.getAttribute('style')).toContain(`height: ${String(size)}px`)
    }
  })

  it('takes the visible name from the named product build', () => {
    vi.stubEnv('DSH_CLIENT_PRODUCT_NAME', 'Harnessy')
    render(<CustomHarnessName />)
    screen.getByText('Harnessy')
  })

  it('fails rather than rendering a mixed identity when a product value is missing', () => {
    expect(() => requiredBuildValue('DSH_CLIENT_MISSING', undefined)).toThrow('requires DSH_CLIENT_MISSING')
  })

  it('renders localized About facts and safe external links', () => {
    const copy = {
      aboutLabel: 'About Harnessy',
      aboutTitle: 'About Harnessy',
      aboutSummary: 'Independent workspace.',
      heroTagline: 'Build deliberately.',
      product: 'Product',
      version: 'Version',
      projectLink: 'Project repository',
      supportLink: 'Support and issues',
    } as const
    const props = {
      productName: 'Harnessy',
      productUrl: 'https://github.com/amAbdoMo/Harnessy',
      supportUrl: 'https://github.com/amAbdoMo/Harnessy/issues',
      version: '0.1.2-rc.1',
      t: (key: keyof typeof copy) => copy[key],
    } as unknown as AboutRowProps
    render(<AboutRow {...props} />)
    screen.getByRole('region', { name: copy.aboutLabel })
    expect(screen.getByText('0.1.2-rc.1')).not.toBeNull()
    for (const link of screen.getAllByRole('link')) {
      expect(link.getAttribute('target')).toBe('_blank')
      expect(link.getAttribute('rel')).toBe('noreferrer')
    }
  })

  it('renders the localized product orientation in the shared hero slot', () => {
    const copy = { heroTagline: 'Build deliberately.' } as const
    const props = { t: (key: keyof typeof copy) => copy[key] } as unknown as CustomHarnessTaglineProps
    render(<CustomHarnessTagline {...props} />)
    expect(screen.getByText(copy.heroTagline).tagName).toBe('P')
  })
})
