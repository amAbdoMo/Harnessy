import { TestClient } from '../../../test-support/client-runtime/src/assembly/test-client.ts'
import { ClientRoster, type AssemblyPlan } from '../../../test-support/client-runtime/src/assembly/roster.ts'
import { remoteDefaultResponses } from '../../../test-support/client-runtime/src/assembly/remote-default-responses.ts'
import * as gateway from '@deepseek-ai/dsh-api-gateway/client'
import * as typert from '@deepseek-ai/dsh-typert-registry/client'
import * as renderer from '@deepseek-ai/dsh-client-ui-renderer/client'
import * as sessions from '@deepseek-ai/dsh-api-session-controller/client'
import * as workspaces from '@deepseek-ai/dsh-api-workspace-controller/client'
import * as uiSession from '@deepseek-ai/dsh-client-ui-session/client'
import * as configForms from '@deepseek-ai/dsh-client-ui-settings/client'
import * as locale from '@deepseek-ai/dsh-client-locale/client'
import * as theme from '@deepseek-ai/dsh-client-ui-theme/client'
import * as layout from '@deepseek-ai/dsh-client-ui-layout/client'
import * as uiWorkspace from '@deepseek-ai/dsh-client-ui-workspace/client'
import * as fileUpload from '@deepseek-ai/dsh-client-file-upload/client'
import * as conversation from '@deepseek-ai/dsh-client-ui-conversation/client'
import * as resources from '@deepseek-ai/dsh-client-resources/client'
import * as sidebarRight from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import * as chat from '@deepseek-ai/dsh-client-ui-chat/client'

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
  '@deepseek-ai/dsh-client-file-upload': fileUpload,
  '@deepseek-ai/dsh-client-ui-conversation': conversation,
  '@deepseek-ai/dsh-client-resources': resources,
  '@deepseek-ai/dsh-client-ui-sidebar-right': sidebarRight,
  '@deepseek-ai/dsh-client-ui-chat': chat,
}

/** Source-plane client application providers for approval panel and Loader replay tests. */
export const approvalRuntimePlan: AssemblyPlan = {
  roster: ClientRoster.of(['@deepseek-ai/dsh-client-connection', '@deepseek-ai/dsh-client-shortcuts', ...Object.keys(provide)].map(name => ({ name, inject: [], immediately: false }))),
  provide,
}
export { TestClient, remoteDefaultResponses }
