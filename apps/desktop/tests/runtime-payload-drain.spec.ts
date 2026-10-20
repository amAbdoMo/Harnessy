import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'

// Windows regression: the DLL-backed terminal exited but its output worker kept the payload smoke alive.
it.skipIf(process.platform !== 'win32').each([
  ['natural terminal exit', []], ['explicit termination', ['--terminate']],
] as const)('drains the real ConPTY output worker after %s', async (_scenario, args) => {
  const fixture = fileURLToPath(new URL('./fixtures/conpty-natural-drain.mjs', import.meta.url))
  const environment = Object.fromEntries(Object.entries(process.env).filter(([name]) => (
    /^(?:path|systemroot|windir|comspec|temp|tmp|ELECTRON_RUN_AS_NODE)$/iu.test(name)
  )))
  const { stdout } = await promisify(execFile)(process.execPath, [fixture, ...args], {
    timeout: 10_000, windowsHide: true, env: environment,
  })
  expect(stdout).toContain('conpty-checks-complete')
  expect(stdout).toContain('conpty-natural-drain-ok')
}, 15_000)
