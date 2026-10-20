/** Require the real bundled ConPTY worker to retire after its output socket drains. */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
const requireOwner = createRequire(new URL('../../../../packages/subprocess/subprocess-local/package.json', import.meta.url))
const pty = requireOwner('node-pty')
const exited = Promise.withResolvers()
const terminate = process.argv[2] === '--terminate'
let killRequested = false
const environment = Object.fromEntries(Object.entries(process.env).filter(([name]) => /^(?:path|systemroot|windir|comspec)$/iu.test(name)))
const terminal = pty.spawn(process.env.ComSpec, ['/d', terminate ? '/k' : '/c', 'echo conpty-drain-fixture'], {
  cwd: process.cwd(), env: environment, cols: 80, rows: 24, useConptyDll: true,
})
let output = ''
const data = terminal.onData(chunk => {
  output += chunk
  if (terminate && !killRequested && output.includes('conpty-drain-fixture')) {
    killRequested = true
    terminal.kill()
  }
})
const exit = terminal.onExit(event => { exited.resolve(event.exitCode) })
const code = await exited.promise
data.dispose()
exit.dispose()
if (!killRequested) terminal.kill()
if (terminate) assert.equal(killRequested, true)
else assert.equal(code, 0)
assert.match(output, /conpty-drain-fixture/)
console.log('conpty-checks-complete')
process.once('beforeExit', () => { console.log('conpty-natural-drain-ok') })
