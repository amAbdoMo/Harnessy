/** Keyless directory expectations through the shipped SDK profile and durable JSONL. */
import { mkdir, mkdtemp, readFile, readdir, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it, onTestFinished } from 'vitest'
import { DeepSeekHarness } from '../src/index.ts'

it('keeps literal first-request cwd, immutable project authority, changes and recovery durable', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'sdk-directory-expected-')))
  const resources: { harness?: DeepSeekHarness } = {}
  onTestFinished(async () => {
    try {
      await resources.harness?.close()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
  const original = join(root, 'project-{{literal}}')
  const selected = join(original, 'selected')
  await mkdir(selected, { recursive: true })
  const options = {
    profile: 'sdk', cwd: original, processCwd: original, dshHome: join(root, 'home'),
    provider: 'directory-keyless', model: 'directory-keyless',
    patches: [fileURLToPath(new URL('./fixtures/directory.cordis.yml', import.meta.url))],
    env: { DSH_TELEMETRY_DISABLED: '1', DSH_AGENTS_HOME: join(root, 'agents') },
  }
  const prompt = (cwd: string) => JSON.stringify({ cwd, original })
  const first = resources.harness = new DeepSeekHarness(options)
  const session = first.session('directory-expectation')
  const initial = await session.run(prompt(original))
  expect(initial.finalResponse, JSON.stringify(initial.events.filter(event => event.type === 'turn/end'))).toBe('DIRECTORY_OK')
  expect(await session.setWorkingDirectory('selected')).toBe(selected)
  expect((await session.run(prompt(selected))).finalResponse).toBe('DIRECTORY_OK')
  expect(await session.getWorkingDirectory()).toBe(selected)
  // This exact owned directory was created above; no other filesystem path is removed.
  await rm(selected, { recursive: true })
  const recovery = await session.run(prompt(original))
  expect(recovery.finalResponse, JSON.stringify(recovery.events.filter(event => event.type === 'turn/end'))).toBe('DIRECTORY_OK')
  expect(await session.getWorkingDirectory()).toBe(original)
  // Clean negative control: a wrong model-input expectation must not produce success.
  const negative = await session.run(prompt(selected))
  expect(negative.finalResponse).toBe('')
  expect(negative.events.filter(event => event.type === 'turn/end')).toMatchObject([
    { data: { reason: { kind: 'error', error: { message: 'DIRECTORY_CONTEXT_MISMATCH' } } } },
  ])
  await first.close()

  const sessionsRoot = join(root, 'home', 'sessions')
  const paths = (await readdir(sessionsRoot, { recursive: true })).filter(path => path.endsWith('.jsonl'))
  expect(paths).toHaveLength(1)
  const rows = (await readFile(join(sessionsRoot, paths[0]!), 'utf8')).trim().split('\n')
    .map(line => JSON.parse(line) as { type: string; cwd?: string; data?: Record<string, unknown> })
  expect(rows[0]?.cwd).toBe(original)
  expect(rows.filter(row => row.type === 'working-directory/change').map(row => row.data)).toEqual([
    { cwd: selected }, { cwd: original },
  ])
  const notices = rows.filter(row => row.type === 'user/message' &&
    (row.data?.['source'] as { kind?: string } | undefined)?.kind === 'working-directory')
  expect(notices).toHaveLength(2)
  expect(JSON.stringify(notices[1]?.data)).toContain('is unavailable')
})
