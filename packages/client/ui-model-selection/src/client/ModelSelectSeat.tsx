/** Bind the saved per-chat Codex preference through the standard projection seat. */
import type {} from '@deepseek-ai/dsh-llm-pi-ai/types'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { ModelSelect } from './ModelSelect.tsx'
import type { ModelSelectInjected } from './slots.ts'

type ModelSelectSeatProps = PropsRuntime<'conversation.input.model'>
  & ModelSelectInjected & PropsLocale<'model'>

/**
 * Render the model selector with the current Session's restored or live fast preference.
 * @param props - framework runtime, directory operations, and localized copy.
 * @returns the model selector; the preference does not assert provider acceptance.
 */
export function ModelSelectSeat(props: ModelSelectSeatProps) {
  const fastEnabled = props.useProjection('codexFastMode') === true
  return <ModelSelect {...props} fastEnabled={fastEnabled} />
}
