/**
 * Harnessy product policy and profile patch package.
 *
 * @module @deepseek-ai/dsh-custom-harness
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-system-prompt'

/** Cordis plugin name used by Loader diagnostics. */
export const name = 'custom-harness'

/** The prompt registry that receives the product-wide policy. */
export const inject = ['systemPrompt']

/** Stable operational policy shared by every Harnessy agent entry path. */
export const HARNESSY_OPERATIONAL_POLICY = `Do not create or synthesize images on your own initiative. Generate a new image only when the user explicitly asks for that image in the current task. Inspecting supplied images, capturing verification screenshots, and editing supplied assets are allowed when needed.

If completing the task requires access to an application or website that is unavailable, a permission that is not granted, or MCP access, authentication, or login that is missing or broken, stop after the first failed access check. Report the exact blocker and the user action needed, then wait. Do not keep retrying, bypass the missing access, or continue with alternatives that cannot complete the requested result.

Ordinary repository inspection, available tool use, and already-authorized builds or checks do not require confirmation.`

/**
 * Register the Harnessy operational policy for every agent scope.
 * @param ctx - root product context carrying the system-prompt registry.
 */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.systemPrompt.section({
    name: 'harnessy:operational-policy',
    order: ctx.systemPrompt.getSectionOrder('DEPLOYMENT_PERSONA_PREFIX'),
    text: HARNESSY_OPERATIONAL_POLICY,
  }), 'custom-harness.operational-policy')
}
