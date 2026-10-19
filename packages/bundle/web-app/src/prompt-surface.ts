/**
 * Prompt sections for the Web surface and the implementation checkout.
 *
 * The two values they describe — the checkout path and the advertised GUI URL
 * — change between processes, while the sections describing them must not: a
 * session resumed after a restart would otherwise see a different request
 * prefix, and the signed thinking of its earlier turns would no longer
 * validate. The sections therefore stay value-free and carry the current
 * values as runtime context, which a session reads per request. A session
 * that already admitted a value-bearing paragraph keeps that paragraph
 * verbatim, so its request prefix does not change at all.
 */

import type { Context } from '@deepseek-ai/cordis'
import { z as zod } from 'zod'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-session-projection/types'
import type { AssembleContext } from '@deepseek-ai/dsh-system-prompt'

/** Prompt-section name of the harness-source location line. */
export const HARNESS_SOURCE_SECTION = 'harness:source'

/** Prompt-section name of the Web GUI orientation. */
export const WEB_SURFACE_SECTION = 'app:web-surface'

/** Host-only projection key of the value-bearing paragraphs a Session admitted. */
const LEGACY_PROMPT = 'webAppLegacyPrompt'

const legacyPromptSchema = zod.object({ source: zod.string().nullable(), web: zod.string().nullable() })

/** Value-bearing harness-source and Web-surface paragraphs of the latest nonempty admitted system prompt. */
type LegacyPrompt = zod.infer<typeof legacyPromptSchema>

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    /** Value-bearing harness-source and Web-surface paragraphs of the latest nonempty admitted system prompt. */
    webAppLegacyPrompt: LegacyPrompt
  }
}

/**
 * The value-bearing paragraphs earlier releases rendered, frozen as they were:
 * never edit these together with the current guidance, or Sessions holding
 * the earlier paragraphs stop matching and rewrite their logged prompt.
 */
const LEGACY_SOURCE = {
  prefix: 'The DeepSeek Harness implementation checkout is at ',
  suffix: '. The checkout location and current working directory are separate values and may differ; '
    + 'never infer the working directory from this path. Use pwd to determine the current working directory. '
    + 'Use this checkout only to inspect or extend DSH itself.',
}
// The frozen copy repeats today's guidance on purpose; the two may diverge.
/* jscpd:ignore-start */
const LEGACY_WEB_SURFACE = {
  prefix: 'You are interacting with the user through the DeepSeek Harness Web GUI at ',
  suffix: '. When the user refers to "this page", "this GUI", or "this app" without naming another target, they mean this GUI. '
    + 'The browser provides no implicit DOM, route, or screenshot context. '
    + 'The client-plugin HMR receiver is active, but client-plugin changes reload without a refresh only while '
    + '`pnpm run dev:web` is also running from this same checkout to rebuild their bundles; verify that watcher before promising automatic updates. '
    + 'Every other change — the apps/web shell and plain packages — requires rebuilding the affected Web artifacts and verifying this existing URL after a page refresh. '
    + 'Starting another server does not update this GUI. '
    + 'The apps/web Vite entry builds the shell but is not a standalone application because only dsh web injects window.__DSH_BOOT__. '
    + 'Do not start a replacement server unless the user asks; if one is needed, use a managed background job and verify its exact URL.',
}
/* jscpd:ignore-end */

/** Guidance of the value-free harness-source section. */
const HARNESS_SOURCE_PROMPT = 'The runtime context names the DeepSeek Harness implementation checkout. '
  + 'The checkout location and current working directory are separate values and may differ; '
  + 'never infer the working directory from the checkout path. Use pwd to determine the current working directory. '
  + 'Use this checkout only to inspect or extend DSH itself.'

/** Guidance of the value-free Web-surface section. */
const WEB_SURFACE_PROMPT = 'You are interacting with the user through the DeepSeek Harness Web GUI whose URL the runtime context names. '
  + 'When the user refers to "this page", "this GUI", or "this app" without naming another target, they mean this GUI. '
  + 'The browser provides no implicit DOM, route, or screenshot context. '
  + 'The client-plugin HMR receiver is active, but client-plugin changes reload without a refresh only while '
  + '`pnpm run dev:web` is also running from this same checkout to rebuild their bundles; verify that watcher before promising automatic updates. '
  + 'Every other change — the apps/web shell and plain packages — requires rebuilding the affected Web artifacts and verifying this existing URL after a page refresh. '
  + 'Starting another server does not update this GUI. '
  + 'The apps/web Vite entry builds the shell but is not a standalone application because only dsh web injects window.__DSH_BOOT__. '
  + 'Do not start a replacement server unless the user asks; if one is needed, use a managed background job and verify its exact URL.'

/** The complete single-line paragraph between `prefix` and `suffix`, or `null` when the prompt has none. */
function legacyParagraph(prompt: string, { prefix, suffix }: { prefix: string; suffix: string }): string | null {
  const start = prompt.indexOf(prefix)
  if (start < 0) return null
  const end = prompt.indexOf(suffix, start + prefix.length)
  if (end < 0) return null
  const paragraph = prompt.slice(start, end + suffix.length)
  return paragraph.includes('\n') ? null : paragraph
}

/**
 * Fold one committed event into the admitted paragraphs. Like the loop's own
 * prompt-version reading, only a single nonempty text block is a prompt
 * version; an emptied or other version keeps the previous state, because a
 * series consolidation can log only the emptied later version.
 */
function foldLegacyPrompt(state: LegacyPrompt, event: SessionEvent): LegacyPrompt {
  if (event.type !== 'system/message') return state
  const { content } = event.data.message
  const [block] = content
  if (content.length !== 1 || block?.type !== 'text' || block.text === '') return state
  const source = legacyParagraph(block.text, LEGACY_SOURCE)
  const web = legacyParagraph(block.text, LEGACY_WEB_SURFACE)
  return source === state.source && web === state.web ? state : { source, web }
}

const ADMITS_NOTHING: LegacyPrompt = { source: null, web: null }

/** The values the sections describe, resolved per request. */
export interface SurfacePromptValues {
  /** Absolute path of the harness checkout root. */
  readonly sourceRoot: string
  /** Canonical URL of the running Web GUI. */
  readonly webUrl: () => string
}

/**
 * Register the harness-source and Web-surface prompt sections with their
 * runtime-context values, and the projection that keeps a Session's admitted
 * paragraphs.
 * @param ctx - plugin context with every injected service.
 * @param values - the current values of the two sections.
 * @returns disposer of every registration.
 */
export function registerSurfacePromptSections(ctx: Context, values: SurfacePromptValues): () => void {
  const projections = ctx.get('sessionProjections')
  const systemPrompt = ctx.get('systemPrompt')
  if (projections === undefined || systemPrompt === undefined) return () => {}
  const admitted = (context: AssembleContext): LegacyPrompt => {
    const session = context.agent?.session
    // This plugin registers the unit above, so its state exists for every Session.
    return session === undefined ? ADMITS_NOTHING : projections.stateOf(session, LEGACY_PROMPT) as LegacyPrompt
  }
  const disposers = [
    projections.register({
      key: LEGACY_PROMPT,
      stateVersion: 1,
      stateSchema: legacyPromptSchema,
      init: () => ADMITS_NOTHING,
      apply: foldLegacyPrompt,
    }),
    systemPrompt.section({
      name: HARNESS_SOURCE_SECTION,
      order: systemPrompt.getSectionOrder('HARNESS_SOURCE'),
      interpolate: false,
      text: context => admitted(context).source ?? HARNESS_SOURCE_PROMPT,
    }),
    systemPrompt.context({
      name: HARNESS_SOURCE_SECTION,
      order: systemPrompt.getContextOrder('HARNESS_SOURCE'),
      interpolate: false,
      text: `Current DeepSeek Harness implementation checkout: ${JSON.stringify(values.sourceRoot)}.`,
    }),
    systemPrompt.section({
      name: WEB_SURFACE_SECTION,
      order: systemPrompt.getSectionOrder('WEB_SURFACE'),
      interpolate: false,
      text: context => admitted(context).web ?? WEB_SURFACE_PROMPT,
    }),
    systemPrompt.context({
      name: WEB_SURFACE_SECTION,
      order: systemPrompt.getContextOrder('WEB_SURFACE'),
      interpolate: false,
      text: () => `Current DeepSeek Harness Web GUI URL: ${JSON.stringify(values.webUrl())}.`,
    }),
  ]
  return () => {
    for (const dispose of disposers) dispose()
  }
}
