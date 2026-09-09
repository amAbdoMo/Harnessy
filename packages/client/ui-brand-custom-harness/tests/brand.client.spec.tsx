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

describe('Custom Harness identity components', () => {
  it('renders one vector mark at every host-owned size', () => {
    const subject = render(<CustomHarnessMark size={16} />)
    const mark = subject.container.querySelector('svg')
    expect(mark?.getAttribute('viewBox')).toBe('0 0 64 64')
    for (const size of [24, 34, 64]) {
      subject.rerender(<CustomHarnessMark size={size} />)
      expect(mark?.getAttribute('width')).toBe(String(size))
      expect(mark?.getAttribute('height')).toBe(String(size))
    }
  })

  it('takes the visible name from the named product build', () => {
    vi.stubEnv('DSH_CLIENT_PRODUCT_NAME', 'Custom Harness')
    render(<CustomHarnessName />)
    screen.getByText('Custom Harness')
  })

  it('fails rather than rendering a mixed identity when a product value is missing', () => {
    expect(() => requiredBuildValue('DSH_CLIENT_MISSING', undefined)).toThrow('requires DSH_CLIENT_MISSING')
  })

  it('renders localized About facts and safe external links', () => {
    const copy = {
      aboutLabel: 'About Custom Harness',
      aboutTitle: 'About Custom Harness',
      aboutSummary: 'Independent workspace.',
      heroTagline: 'Build deliberately.',
      product: 'Product',
      version: 'Version',
      projectLink: 'Project repository',
      supportLink: 'Support and issues',
    } as const
    const props = {
      productName: 'Custom Harness',
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
