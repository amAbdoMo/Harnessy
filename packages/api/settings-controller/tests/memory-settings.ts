import { Context, Service } from '@deepseek-ai/cordis'
import type { SettingsDescriptor, SettingsPathOp } from '@deepseek-ai/dsh-settings'

/** Minimal profile-settings service for account-controller unit tests. */
export class MemorySettings extends Service {
  private readonly sections: Record<string, Record<string, unknown>> = {
    'llm-pi-ai': { providers: {} },
  }

  constructor(ctx: Context) {
    super(ctx, 'settings')
  }

  /** Return detached live values in the production descriptor vocabulary. */
  describe(): SettingsDescriptor[] {
    return Object.entries(this.sections).map(([ns, value]) => ({
      ns: ns as SettingsDescriptor['ns'], autoGenerate: false, schema: {}, value: structuredClone(value),
      revision: 0, applies: 'live',
    }))
  }

  /** Apply the path edits used by the account controllers. */
  mutate(namespace: string, operations: readonly SettingsPathOp[]): Promise<void> {
    const section = this.sections[namespace] ??= {}
    for (const operation of operations) {
      let parent: Record<string, unknown> = section
      for (const key of operation.path.slice(0, -1)) {
        const child = parent[key]
        if (typeof child === 'object' && child !== null && !Array.isArray(child)) parent = child as Record<string, unknown>
        else parent = parent[key] = {}
      }
      const key = operation.path.at(-1)
      if (key === undefined) continue
      if (operation.op === 'set') parent[key] = structuredClone(operation.value)
      else Reflect.deleteProperty(parent, key)
    }
    return Promise.resolve()
  }
}
