/** Source-plane application composition; only native guests and Remote IO are inert. */
import { ClientRoster, type AssemblyPlan } from '@deepseek-ai/dsh-client-test-runtime/src/assembly/index.ts'
import * as gateway from '@deepseek-ai/dsh-api-gateway/src/client/index.ts'
import * as typert from '@deepseek-ai/dsh-typert-registry/src/client/index.ts'
import * as renderer from '@deepseek-ai/dsh-client-ui-renderer/src/client/index.ts'
import * as sessions from '@deepseek-ai/dsh-api-session-controller/src/client/index.ts'
import * as workspaces from '@deepseek-ai/dsh-api-workspace-controller/src/client/index.ts'
import * as uiSession from '@deepseek-ai/dsh-client-ui-session/src/client/index.ts'
import * as configForms from '@deepseek-ai/dsh-client-ui-settings/src/client/index.ts'
import * as locale from '@deepseek-ai/dsh-client-locale/src/client/index.ts'
import * as theme from '@deepseek-ai/dsh-client-ui-theme/src/client/index.ts'
import * as layout from '@deepseek-ai/dsh-client-ui-layout/src/client/index.ts'
import * as uiWorkspace from '@deepseek-ai/dsh-client-ui-workspace/src/client/index.ts'
import * as resources from '@deepseek-ai/dsh-client-resources/src/client/index.ts'
import * as sidebarRight from '@deepseek-ai/dsh-client-ui-sidebar-right/src/client/index.ts'

const provide: NonNullable<AssemblyPlan['provide']> = {
  '@deepseek-ai/dsh-api-gateway': gateway,
  '@deepseek-ai/dsh-typert-registry': typert,
  '@deepseek-ai/dsh-client-ui-renderer': renderer,
  '@deepseek-ai/dsh-api-session-controller': sessions,
  '@deepseek-ai/dsh-api-workspace-controller': workspaces,
  '@deepseek-ai/dsh-client-ui-session': uiSession,
  '@deepseek-ai/dsh-client-ui-settings': configForms,
  '@deepseek-ai/dsh-client-locale': locale,
  '@deepseek-ai/dsh-client-ui-theme': theme,
  '@deepseek-ai/dsh-client-ui-layout': layout,
  '@deepseek-ai/dsh-client-ui-workspace': uiWorkspace,
  '@deepseek-ai/dsh-client-resources': resources,
  '@deepseek-ai/dsh-client-ui-sidebar-right': sidebarRight,
}

/** Real layout, locale, renderer and Sidebar behind the YAML-loaded feature. */
export const devicePreviewRuntimePlan: AssemblyPlan = {
  roster: ClientRoster.of(['@deepseek-ai/dsh-client-connection', '@deepseek-ai/dsh-client-shortcuts', ...Object.keys(provide)]
    .map(name => ({ name, inject: [], immediately: false }))),
  provide,
}
