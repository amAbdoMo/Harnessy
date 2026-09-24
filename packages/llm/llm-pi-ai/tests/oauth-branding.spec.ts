import { describe, expect, it } from 'vitest'

type OAuthPageModule = {
  oauthSuccessHtml: (message: string) => string
  oauthErrorHtml: (message: string, details?: string) => string
}

async function oauthPage(): Promise<OAuthPageModule> {
  const packageEntry = import.meta.resolve('@earendil-works/pi-ai')
  const moduleUrl = new URL('./auth/oauth/oauth-page.js', packageEntry)
  return await import(moduleUrl.href) as OAuthPageModule
}

describe('Harnessy OAuth callback page', () => {
  it('renders the Harnessy identity on successful browser callbacks', async () => {
    const page = await oauthPage()
    const html = page.oauthSuccessHtml('OpenAI authentication completed.')

    expect(html).toContain('<title>Account connected · Harnessy</title>')
    expect(html).toContain('Harnessy · Secure sign-in')
    expect(html).toContain('aria-label="Harnessy"')
    expect(html).toContain('#20C6CC')
    expect(html).toContain('OpenAI authentication completed.')
    expect(html).not.toContain('viewBox="0 0 800 800"')
  })

  it('uses the same identity for failures and continues escaping provider text', async () => {
    const page = await oauthPage()
    const html = page.oauthErrorHtml('Could not connect <account>.', 'Reason: "denied"')

    expect(html).toContain('<title>Connection failed · Harnessy</title>')
    expect(html).toContain('Harnessy · Secure sign-in')
    expect(html).toContain('Could not connect &lt;account&gt;.')
    expect(html).toContain('Reason: &quot;denied&quot;')
    expect(html).not.toContain('Could not connect <account>.')
  })
})
