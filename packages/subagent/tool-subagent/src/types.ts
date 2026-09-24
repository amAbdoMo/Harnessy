/**
 * Browser-safe child LLM route vocabulary: the exact provider/model pair a user
 * authorizes for explicit selection, plus the schema the Host setting and its
 * deployment base share.
 *
 * These declarations live in this lean module rather than in
 * `./model-selection.ts` because that module reaches the Agent and LLM runtimes
 * to preflight a route, while a browser surface that only renders configured
 * routes must not load them.
 *
 * @module @deepseek-ai/dsh-tool-subagent/types
 */

import z from '@deepseek-ai/schemastery'

/** One exact child LLM route authorized by a user setting. */
export interface AllowedModelRoute {
  /** Registered LLM provider id. */
  readonly provider: string
  /** Provider-owned exact model id. */
  readonly model: string
}

/** Schema shared by the Host setting and its deployment base. */
export const AllowedModelRouteSchema: z<AllowedModelRoute> = z.object({
  provider: z.string().min(1).required(),
  model: z.string().min(1).required(),
})
