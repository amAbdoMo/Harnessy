/**
 * Host-owned OpenAI account sign-in for the desktop Models settings surface.
 * OAuth tokens never cross the Remote boundary: the existing authorization
 * flow writes them directly to the credential store.
 *
 * @module @deepseek-ai/dsh-api-settings-controller/src/openai-account
 */

import { Context } from '@deepseek-ai/cordis'
import type { AuthorizationPrompt, AuthorizationService } from '@deepseek-ai/dsh-authorization'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import type { CredentialProvider } from '@deepseek-ai/dsh-credentials'
import { openNativeUrl } from '@deepseek-ai/dsh-native-command'
import type { SettingsProvider } from '@deepseek-ai/dsh-settings'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { OpenAIAccountState, OpenAIAccountSignInResult } from './types.ts'

const OPENAI_KEY = credentialKey('llm-pi-ai', 'openai-codex')
const OPENAI_PROVIDER = 'openai-codex'
const PI_AI_SETTINGS = 'llm-pi-ai'

/** Native browser boundary replaceable by unit tests. */
export interface OpenAIAccountControllerInternals {
  readonly openUrl?: (url: string, signal: AbortSignal) => Promise<void>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Host owner of the `openAIAccount` Remote namespace. */
    openAIAccountController: OpenAIAccountController
  }
}

/**
 * Expose the one-click ChatGPT OAuth path used by Custom Harness. The neutral
 * authorization service still owns the provider conversation and token write;
 * this controller supplies the Windows-desktop interaction: browser login and
 * a cancellable wait for the local OAuth callback.
 */
export class OpenAIAccountController extends TypertRemoteService {
  private readonly openUrl: (url: string, signal: AbortSignal) => Promise<void>

  /** @param ctx - Host context carrying authorization, credentials, and settings when composed. */
  constructor(ctx: Context, internals: OpenAIAccountControllerInternals = {}) {
    super(ctx, 'openAIAccountController', { namespace: 'openAIAccount' })
    this.openUrl = internals.openUrl ?? openNativeUrl
  }

  /**
   * Return account availability and local sign-in state without exposing a token.
   * @returns Redacted availability, configuration, progress, and writability state.
   */
  @Remote
  async describe(): Promise<OpenAIAccountState> {
    const authorization = this.ctx.get('authorization')
    const credentials = this.ctx.get('credentials')
    const entry = authorization?.describe(OPENAI_KEY)
    if (entry === undefined || credentials === undefined) {
      return { available: false, configured: false, inFlight: false, writable: false }
    }
    const record = await credentials.describeRecord(OPENAI_KEY)
    return {
      available: entry.methods.some(method => method.id === 'oauth'),
      configured: record.configured,
      inFlight: entry.inFlight,
      writable: record.writable,
    }
  }

  /**
   * Start ChatGPT browser OAuth, wait for its local callback, then activate the
   * OpenAI Codex provider route so its models appear immediately.
   * @param signal - Remote request lifetime; aborting it cancels the login attempt.
   * @returns Whether the provider completed or cancelled authorization.
   */
  @Remote
  async signIn(signal: AbortSignal): Promise<OpenAIAccountSignInResult> {
    const authorization = this.authorization()
    const entry = authorization.describe(OPENAI_KEY)
    if (entry === undefined || !entry.methods.some(method => method.id === 'oauth')) {
      throw unavailable('the OpenAI ChatGPT authorization flow is not installed')
    }

    let opening = Promise.resolve()
    let openFailure: unknown
    const interaction = {
      notify: (notice: { readonly url?: string }): void => {
        if (notice.url === undefined) return
        let url: string
        try {
          url = secureUrl(notice.url)
        } catch (error: unknown) {
          openFailure = error
          authorization.cancel(OPENAI_KEY)
          return
        }
        opening = opening.then(() => this.openUrl(url, signal)).catch((error: unknown) => {
          openFailure = error
          authorization.cancel(OPENAI_KEY)
        })
      },
      prompt: (prompt: AuthorizationPrompt): Promise<string> => answerDesktopPrompt(prompt, signal),
    }

    const outcome = await authorization.begin({
      key: OPENAI_KEY,
      method: 'oauth',
      interaction,
      signal,
    })
    await opening
    if (openFailure !== undefined) {
      if (openFailure instanceof RemoteError) throw openFailure
      throw new RemoteError(
        'openai-account/browser-failed',
        `could not open the OpenAI sign-in page: ${messageOf(openFailure)}`,
        {},
        { cause: openFailure },
      )
    }
    if (outcome.status === 'authorized') await this.activateProvider()
    return { status: outcome.status }
  }

  /** Remove the local OAuth grant and the model route that depends on it. */
  @Remote
  async signOut(): Promise<void> {
    await this.credentials().deleteRecord(OPENAI_KEY)
    await this.settings().mutate(PI_AI_SETTINGS, [{
      op: 'unset',
      path: ['providers', OPENAI_PROVIDER],
    }])
  }

  private async activateProvider(): Promise<void> {
    await this.settings().mutate(PI_AI_SETTINGS, [{
      op: 'set',
      path: ['providers', OPENAI_PROVIDER],
      value: {},
    }])
  }

  private authorization(): AuthorizationService {
    const service = this.ctx.get('authorization')
    if (service === undefined) throw unavailable('authorization service is not mounted')
    return service
  }

  private credentials(): CredentialProvider {
    const service = this.ctx.get('credentials')
    if (service === undefined) throw unavailable('credential storage is not mounted')
    return service
  }

  private settings(): SettingsProvider {
    const service = this.ctx.get('settings')
    if (service === undefined) throw unavailable('settings storage is not mounted')
    return service
  }
}

/** Auto-select browser login; every later code prompt waits for callback or cancellation. */
function answerDesktopPrompt(prompt: AuthorizationPrompt, requestSignal: AbortSignal): Promise<string> {
  if (prompt.kind === 'select') {
    const browser = prompt.options.find(option => option.id === 'browser')
    if (browser === undefined) throw unavailable('the OpenAI flow does not offer browser login')
    return Promise.resolve(browser.id)
  }
  if (requestSignal.aborted || prompt.signal?.aborted === true) {
    return Promise.reject(new Error('the browser sign-in prompt was withdrawn'))
  }
  return new Promise<string>((_resolve, reject) => {
    const withdraw = (): void => {
      requestSignal.removeEventListener('abort', withdraw)
      prompt.signal?.removeEventListener('abort', withdraw)
      reject(new Error('the browser sign-in prompt was withdrawn'))
    }
    requestSignal.addEventListener('abort', withdraw, { once: true })
    prompt.signal?.addEventListener('abort', withdraw, { once: true })
  })
}

/** Admit only encrypted browser destinations from the provider flow. */
function secureUrl(value: string): string {
  let url: URL
  try {
    url = new URL(value)
  } catch (error: unknown) {
    throw unavailable(`the OpenAI flow returned an invalid sign-in URL: ${messageOf(error)}`)
  }
  if (url.protocol !== 'https:') throw unavailable('the OpenAI sign-in URL must use HTTPS')
  return url.href
}

function unavailable(message: string): RemoteError {
  return new RemoteError('openai-account/unavailable', message, {})
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export default OpenAIAccountController
