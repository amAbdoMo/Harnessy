/** Release preparation must leave representative user-owned Desktop stores intact across install-directory changes. */

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { packagedDesktopEnvironment } from '../src/packaged-environment.js'
import { resolveDesktopPaths } from '../src/paths.ts'
import { DesktopProjectManager } from '../src/project-manager.ts'
import { runtimeFixture } from './runtime-fixture.ts'

const roots: string[] = []

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'harnessy-upgrade-settings-'))
  roots.push(root)
  return root
}

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

describe('Desktop release settings preservation', () => {
  it('preserves saved configuration and state when a new installation prepares the existing profile', async () => {
    const root = await temporaryRoot()
    const localAppData = join(root, 'LocalAppData')
    const firstResources = join(root, 'Install-v1', 'resources')
    const nextResources = join(root, 'Install-v2', 'resources')
    const first = packagedDesktopEnvironment(firstResources, { LOCALAPPDATA: localAppData })
    const next = packagedDesktopEnvironment(nextResources, { LOCALAPPDATA: localAppData })
    runtimeFixture(join(firstResources, 'dsh'))
    runtimeFixture(join(nextResources, 'dsh'))

    const firstManager = new DesktopProjectManager(resolveDesktopPaths(first.DSH_HOME), {
      dsh: join(firstResources, 'dsh'),
    })
    await firstManager.applyRelease()

    const saved = [
      [join(firstManager.paths.profile, 'cordis.patch.yml'), [
        '- name: subagent-roster',
        '  config:',
        '    roles:',
        '      - id: custom-reviewer',
        '        model: provider/custom-agent-model',
        '    overrides:',
        '      default:',
        '        model: provider/default-agent-override',
        '- name: llm-pi-ai',
        '  config:',
        '    providers:',
        '      custom-provider:',
        '        models: [custom-added-model]',
        '',
      ].join('\n')],
      [join(first.DSH_HOME, '.credentials.yaml'), [
        'version: 1',
        'records:',
        '  account-manager/accounts:',
        '    kind: grant',
        '    payload:',
        '      version: 1',
        '      providers:',
        '        openai-codex:',
        '          accounts:',
        '            synthetic-account:',
        '              name: Saved account',
        '              subscriptionReference: synthetic-plan-reference',
        '  mcp-manager/servers:',
        '    kind: grant',
        '    payload:',
        '      version: 1',
        '      servers: []',
        '',
      ].join('\n')],
      [join(first.DSH_HOME, 'mcp-servers.json'), '{"version":1,"servers":[{"name":"saved-mcp-definition"}]}\n'],
      [join(first.DSH_HOME, 'sessions', 'saved-chat.jsonl'), '{"type":"session","id":"saved-chat"}\n'],
      [join(first.DSH_AGENTS_HOME, 'custom-reviewer', 'agent.json'), '{"model":"provider/custom-agent-model"}\n'],
      [join(first.CUSTOM_HARNESS_DESKTOP_USER_DATA, 'website-profiles.json'),
        '{"version":1,"profiles":[{"id":"synthetic-saved-login"}]}\n'],
      [join(first.CUSTOM_HARNESS_DESKTOP_USER_DATA, 'Cookies'), 'synthetic browser session state'],
    ] as const
    for (const [path, contents] of saved) {
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, contents)
    }

    expect(next.DSH_HOME).toBe(first.DSH_HOME)
    expect(next.DSH_AGENTS_HOME).toBe(first.DSH_AGENTS_HOME)
    expect(next.CUSTOM_HARNESS_DESKTOP_USER_DATA).toBe(first.CUSTOM_HARNESS_DESKTOP_USER_DATA)
    await rm(join(root, 'Install-v1'), { recursive: true })

    const nextManager = new DesktopProjectManager(resolveDesktopPaths(next.DSH_HOME), {
      dsh: join(nextResources, 'dsh'),
    })
    await nextManager.applyRelease()

    await expect(Promise.all(saved.map(async ([path]) => readFile(path, 'utf8'))))
      .resolves.toEqual(saved.map(([, contents]) => contents))
  })
})
