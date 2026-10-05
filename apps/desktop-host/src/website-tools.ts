/** Discovery and preparation return no live page data; request-scoped page information requires fresh consent. */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-user-approval'
import type { WebsiteRequestsController, WebsiteRequestToolScope } from './website-requests.ts'
import type { WebsiteParentChannel } from './website-parent.ts'
import { websiteHostSnapshot } from './website-control.ts'
import { installWebsiteBrowserTool } from './website-browser-tools.ts'

/**
 * Install one consented page-info tool only in the captured initiating Agent's scope.
 * @param scope - exact grant, owner and request-bound executor; no model-supplied authority identifiers.
 * @param parent - private same-guest transport with independent physical settlement.
 * @returns synchronous registration disposer retained by the request through revocation.
 */
export function installWebsitePageInfoTool(scope: WebsiteRequestToolScope, parent: WebsiteParentChannel): () => void {
  const name = `website_page_info_${scope.request.requestId}`
  return scope.agent.ctx.tools.register(defineTool({
    name,
    description: `Read the current page title and origin for saved website ${JSON.stringify(scope.profile.name)} / account ${JSON.stringify(scope.profile.accountLabel)}. Asks for fresh approval on every call; returns no login state, page body or full URL. Prefer the paired MCP for website work.`,
    parameters: {},
    output: {
      schema: { type: 'object', additionalProperties: false, properties: {
        origin: { type: 'string', required: true }, title: { type: 'string', required: true },
        titleTruncated: { type: 'boolean', required: true },
      } },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(_args, execution) {
      scope.agent.ctx.tools.guardResult(execution, (result) => {
        if (Buffer.byteLength(JSON.stringify(result), 'utf8') > 8192) throw new Error('Website page information exceeded the complete result limit')
        return undefined
      })
      return scope.run(execution, async (signal) => {
        const operation = parent.beginOperation(websiteHostSnapshot(scope.request), 'page-info', signal)
        try { return await operation.result }
        finally { await operation.settled }
      }, { operation: 'page-info' })
    },
    presentCall: () => ({ card: 'generic', title: 'Read approved website page title and origin', kind: 'read' }),
  }))
}

/** @param scope - exact committed request and its owning Agent. @param parent - captured native transport.
 * @returns removal of both scoped tools; partial registration rolls back before throwing.
 */
export function installWebsiteRequestTools(scope: WebsiteRequestToolScope, parent: WebsiteParentChannel): () => void {
  const pageInfo = installWebsitePageInfoTool(scope, parent)
  try {
    const browser = installWebsiteBrowserTool(scope, parent)
    return () => { browser(); pageInfo() }
  } catch (error: unknown) { pageInfo(); throw error }
}

/**
 * @param ctx - desktop Host plugin lifetime; registrations wait for Tools and leave with this context.
 * @param requests - exact-owner request controller with the enrolled inventory.
 * @param parent - private Main-process capture channel.
 * @returns registration readiness; await after the configured services have loaded, never during pre-plugin setup.
 */
export function installWebsiteTools(ctx: Context, requests: WebsiteRequestsController, parent: WebsiteParentChannel): ReturnType<Context['inject']> {
  return ctx.inject(['tools'], (scope) => {
    scope.tools.register(defineTool({
      name: 'website_profiles',
      description: 'List remembered website/account pairings for desktop website work. Returns saved labels and addresses, not login state or page content.',
      parameters: {},
      output: {
        schema: { type: 'array', items: { type: 'object', additionalProperties: false, properties: {
          profileId: { type: 'string', required: true }, name: { type: 'string', required: true },
          accountLabel: { type: 'string', required: true }, url: { type: 'string', required: true },
          mcpServerName: { type: 'string', required: true },
        } } },
        render: (_args, profiles) => [{ type: 'text', text: JSON.stringify(profiles) }],
      },
      execute(_args, execution) {
        if (execution.agent === undefined) throw new Error('Website work requires an owning agent session')
        execution.signal.throwIfAborted()
        return Promise.resolve(requests.profiles().map(profile => ({ profileId: profile.id, name: profile.name,
          accountLabel: profile.accountLabel, url: profile.url, mcpServerName: profile.serverName })))
      },
      presentCall: () => ({ card: 'generic', title: 'List saved website accounts', kind: 'read' }),
    }))
    scope.tools.register(defineTool({
      name: 'website_prepare',
      description: 'Request work on one saved website/account. Returns a paused request; the human must log in and explicitly Resume that request before any MCP or browser observation. Never read passwords, verification codes, or login-page content. Prefer the paired MCP for bulk work.',
      parameters: { profileId: { type: 'string', required: true,
        description: 'The exact profileId from website_profiles; do not substitute another account.' } },
      output: {
        schema: { type: 'object', additionalProperties: false, properties: {
          requestId: { type: 'string', required: true }, profileId: { type: 'string', required: true },
          mcpServerName: { type: 'string', required: true }, status: { type: 'string', enum: ['pending'], required: true },
        } },
        render: (_args, request) => [{ type: 'text', text: `${JSON.stringify(request)}\nWaiting for the human to Resume this request. No page access is granted.` }],
      },
      async execute(args, execution) {
        const profile = requests.profiles().find(profile => profile.id === args.profileId)
        if (profile === undefined) throw new Error('Saved website/account was not found; ask the human to create or select its pairing')
        const request = requests.create(execution, profile)
        await requests.handoff(request, signal => parent.prepare(websiteHostSnapshot(request), signal))
        execution.signal.throwIfAborted()
        requests.assertCurrent(request)
        return { requestId: request.requestId, profileId: request.profileId,
          mcpServerName: request.serverName, status: 'pending' as const }
      },
      presentCall: args => ({ card: 'generic', title: 'Prepare saved website work', kind: 'other', rawInput: args.profileId }),
    }))
  })
}
