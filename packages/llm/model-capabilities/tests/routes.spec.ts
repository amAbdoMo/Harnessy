import { describe, expect, it } from 'vitest'
import {
  normalizeProviderId,
  normalizeRouteHost,
  openRouterRouteProvider,
  routeHostKey,
} from '@deepseek-ai/dsh-model-capabilities'

describe('normalizeRouteHost', () => {
  it('returns nothing for an endpoint that states no host', () => {
    expect(normalizeRouteHost(undefined)).toBeUndefined()
    expect(normalizeRouteHost('')).toBeUndefined()
    expect(normalizeRouteHost('://broken')).toBeUndefined()
  })

  it('folds case, assumes https for a missing scheme, and drops the www prefix', () => {
    expect(normalizeRouteHost('https://API.OpenAI.com/v1')).toEqual({ host: 'api.openai.com' })
    expect(normalizeRouteHost('api.openai.com')).toEqual({ host: 'api.openai.com' })
    expect(normalizeRouteHost('www.api.openai.com/v1')).toEqual({ host: 'api.openai.com' })
  })

  it('ignores path, query, and fragment, so a trailing slash and a /v1 segment are immaterial', () => {
    for (const raw of [
      'https://gateway.example',
      'https://gateway.example/',
      'https://gateway.example/v1',
      'https://gateway.example/v1/',
      'https://gateway.example/v1/models?page=2#top',
    ]) {
      expect(normalizeRouteHost(raw), raw).toEqual({ host: 'gateway.example' })
    }
  })

  it('drops the scheme default port and keeps one that distinguishes a gateway', () => {
    expect(normalizeRouteHost('https://gateway.example:443/v1')).toEqual({ host: 'gateway.example' })
    expect(normalizeRouteHost('http://gateway.example:80/v1')).toEqual({ host: 'gateway.example' })
    expect(normalizeRouteHost('https://gateway.example:8443/v1')).toEqual({
      host: 'gateway.example',
      port: '8443',
    })
    expect(normalizeRouteHost('http://127.0.0.1:8080/v1')).toEqual({ host: '127.0.0.1', port: '8080' })
  })

  it('rejects an endpoint the URL parser cannot read', () => {
    // An authority that states neither a host nor a readable port leaves the
    // route with no comparable identity.
    expect(normalizeRouteHost('https://:443/v1')).toBeUndefined()
    expect(normalizeRouteHost('https://')).toBeUndefined()
  })

  it('rejects an endpoint whose host is nothing but the dropped prefix', () => {
    expect(normalizeRouteHost('https://www./v1')).toBeUndefined()
  })
})

describe('routeHostKey', () => {
  it('keeps a stated port, because two ports on one host are two endpoints', () => {
    expect(routeHostKey({ host: 'gateway.example' })).toBe('gateway.example')
    expect(routeHostKey({ host: '127.0.0.1', port: '8080' })).toBe('127.0.0.1:8080')
    expect(routeHostKey({ host: '127.0.0.1', port: '8080' }))
      .not.toBe(routeHostKey({ host: '127.0.0.1', port: '9090' }))
  })
})

describe('normalizeProviderId', () => {
  it('compares provider identities by their alphanumerics alone', () => {
    expect(normalizeProviderId('openai-codex')).toBe('openaicodex')
    expect(normalizeProviderId('OpenAI Codex')).toBe('openaicodex')
    expect(normalizeProviderId('OpenRouter')).toBe('openrouter')
  })
})

describe('openRouterRouteProvider', () => {
  it('recognizes OpenRouter by endpoint host', () => {
    expect(openRouterRouteProvider({ baseURL: 'https://openrouter.ai/api/v1' })).toBe('openrouter')
    expect(openRouterRouteProvider({ baseURL: 'openrouter.ai' })).toBe('openrouter')
    expect(openRouterRouteProvider({ baseURL: 'https://gateway.openrouter.ai/v1' })).toBe('openrouter')
  })

  it('recognizes OpenRouter by route id', () => {
    expect(openRouterRouteProvider({ provider: 'openrouter' })).toBe('openrouter')
    expect(openRouterRouteProvider({ provider: 'Open-Router' })).toBe('openrouter')
  })

  it('recognizes nothing else', () => {
    expect(openRouterRouteProvider({})).toBeUndefined()
    expect(openRouterRouteProvider({ provider: '' })).toBeUndefined()
    expect(openRouterRouteProvider({ provider: 'openai', baseURL: 'https://api.openai.com/v1' })).toBeUndefined()
    // A host that merely contains the name is not OpenRouter's.
    expect(openRouterRouteProvider({ baseURL: 'https://openrouter.ai.example.com/v1' })).toBeUndefined()
  })
})
