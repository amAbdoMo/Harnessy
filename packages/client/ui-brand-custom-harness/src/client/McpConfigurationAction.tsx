import { useState } from 'react'
import type { ReactNode } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import css from './McpConfigurationAction.module.css'

/** Host action supplied to the MCP-only Settings header control. */
export interface McpConfigurationActionInjected {
  openConfigurationFile: () => Promise<{ readonly error?: string }>
}

/** Complete props for the MCP Settings header action. */
export type McpConfigurationActionProps = PropsRuntime<'settings.action'>
  & PropsLocale<'customHarnessBrand'>
  & InjectFace<McpConfigurationActionInjected>

/** Render the MCP document action only while the MCP page is selected. */
export function McpConfigurationAction({
  activeSectionId, openConfigurationFile, t,
}: McpConfigurationActionProps): ReactNode {
  const [opening, setOpening] = useState(false)
  const [error, setError] = useState<string | undefined>()
  if (activeSectionId !== 'custom-harness-mcp') return null

  const open = (): void => {
    setOpening(true)
    setError(undefined)
    void openConfigurationFile()
      .then((result) => { setError(result.error) })
      .finally(() => { setOpening(false) })
  }

  return (
    <div className={css.action}>
      {error === undefined ? null : <span role="alert">{error}</span>}
      <Button variant="outline" size="sm" disabled={opening} onClick={open}>
        {t('mcpOpenConfiguration')}
      </Button>
    </div>
  )
}
