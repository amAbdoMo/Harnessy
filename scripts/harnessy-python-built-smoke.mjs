/** Smoke the published Python runtime exports and packaged Python assets from checked Host libraries. */
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'

const root = resolve(import.meta.dirname, '..')
const packageRoot = resolve(root, 'packages/experimental/ptc-runtime-python')
const { values } = parseArgs({ options: {
  'layout-check-only': { type: 'boolean', default: false },
  report: { type: 'string' },
}, allowPositionals: false })
const layoutOnly = values['layout-check-only']
const reportArgument = values.report
if (!layoutOnly && process.platform !== 'linux' && process.platform !== 'darwin') throw new Error('built Python runtime smoke requires native Linux or macOS; use --layout-check-only for import and asset checks')
if (!reportArgument) throw new Error('--report must name an evidence file inside the checkout')
const reportPath = resolve(reportArgument)
const reportRelative = relative(resolve(root, '.artifacts'), reportPath)
if (reportRelative === '' || reportRelative === '..' || reportRelative.startsWith(`..${sep}`) || isAbsolute(reportRelative)) {
  throw new Error('--report must name a file inside the checkout artifacts directory')
}
const report = { schemaVersion: 1, status: 'failed', checks: [], errors: [] }
const record = (name) => report.checks.push(name)
let ctx
let readOnlyCtx
let tempRoot
try {
  const packageRequire = createRequire(new URL('../packages/experimental/ptc-runtime-python/package.json', import.meta.url))
  const importPublicExport = async (name) => import(pathToFileURL(packageRequire.resolve(name)).href)
  const [cordis, sandboxLocal, sandboxPolicy, sessionProjection, pythonRuntime] = await Promise.all([
    importPublicExport('@deepseek-ai/cordis'),
    importPublicExport('@deepseek-ai/dsh-sandbox-local'),
    importPublicExport('@deepseek-ai/dsh-sandbox-policy'),
    importPublicExport('@deepseek-ai/dsh-session-projection'),
    importPublicExport('@deepseek-ai/dsh-experimental-ptc-runtime-python'),
  ])
  const Context = cordis.Context
  const Sandbox = sandboxLocal.default
  const SandboxPolicy = sandboxPolicy.default
  const SessionProjections = sessionProjection.default
  const PythonPtcRuntime = pythonRuntime.default
  if (typeof Context !== 'function' || typeof Sandbox !== 'function' || typeof SandboxPolicy !== 'function'
    || typeof SessionProjections !== 'function' || typeof PythonPtcRuntime !== 'function') {
    throw new Error('one or more built public package exports are missing')
  }
  record('built public package exports resolve from the Python runtime package')

  const manifest = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'))
  if (!manifest.files?.includes('lib/index.js') || !manifest.files?.includes('py/**/*.py')) throw new Error('package manifest does not publish its built entrypoint and Python assets')
  const entry = join(packageRoot, 'lib/index.js')
  await lstat(entry)
  await lstat(join(packageRoot, 'py/bootstrap.py'))
  await lstat(join(packageRoot, 'py/protocol.py'))
  record('public built entrypoint and both packaged Python assets exist')

  if (layoutOnly) {
    report.status = 'layout-only-success'
  } else {

  tempRoot = await mkdtemp(join(homedir(), '.dsh-python-built-smoke-'))
  const workspace = join(tempRoot, 'workspace')
  await mkdir(workspace)
  const outside = join(tempRoot, 'outside.txt')
  await writeFile(outside, 'protected')
  ctx = new Context()
  await ctx.plugin(Sandbox, {})
  await ctx.plugin(SessionProjections)
  await ctx.plugin(SandboxPolicy, { mode: 'workspace-write', workspaceRoot: workspace })
  await ctx.plugin(PythonPtcRuntime)
  const runtime = ctx.ptcRuntime
  const allowed = await runtime.run(runtime.resolve({ program: `print("built-python-ok")\nopen(${JSON.stringify(join(workspace, 'allowed.txt'))}, "w").write("ok")\nreturn 42`, bindings: [] }))
  if (allowed.error || allowed.value !== 42 || allowed.sandbox?.mode !== 'workspace-write' || allowed.sandbox.denied) throw new Error(`built Python workspace run failed: ${JSON.stringify(allowed)}`)
  if (!allowed.logs.join('').includes('built-python-ok')) throw new Error('built Python output was not captured by the public result')
  if (await readFile(join(workspace, 'allowed.txt'), 'utf8') !== 'ok') throw new Error('workspace write did not persist')
  record('built package launches Python, returns a value, and permits workspace writes')

  const denied = await runtime.run(runtime.resolve({ program: `open(${JSON.stringify(outside)}, "w").write("escaped")`, bindings: [] }))
  if (denied.error?.kind !== 'exception' || denied.sandbox?.mode !== 'workspace-write' || !denied.sandbox.denied
    || await readFile(outside, 'utf8') !== 'protected') throw new Error('built package did not report an enforced outside-workspace denial')
  record('built package denies writes outside its workspace')

  readOnlyCtx = new Context()
  await readOnlyCtx.plugin(Sandbox, {})
  await readOnlyCtx.plugin(SessionProjections)
  await readOnlyCtx.plugin(SandboxPolicy, { mode: 'read-only', workspaceRoot: workspace })
  await readOnlyCtx.plugin(PythonPtcRuntime)
  const readOnlyRuntime = readOnlyCtx.ptcRuntime
  const deniedTarget = join(workspace, 'denied.txt')
  const readOnly = await readOnlyRuntime.run(readOnlyRuntime.resolve({ program: `open(${JSON.stringify(deniedTarget)}, "w").write("no")`, bindings: [] }))
  if (readOnly.error?.kind !== 'exception' || readOnly.sandbox?.mode !== 'read-only' || !readOnly.sandbox.denied) {
    throw new Error('built package did not report an enforced direct-write denial under read-only policy')
  }
  try { await lstat(deniedTarget); throw new Error('built package created the denied read-only target') }
  catch (error) { if (error?.code !== 'ENOENT') throw error }
  record('built package denies direct writes under read-only policy')
  report.status = 'success'
  }
} catch (error) {
  report.errors.push(String(error))
} finally {
  if (ctx) {
    try { await ctx.fiber.dispose() } catch (error) { report.errors.push(`context disposal: ${String(error)}`) }
  }
  if (readOnlyCtx) {
    try { await readOnlyCtx.fiber.dispose() } catch (error) { report.errors.push(`read-only context disposal: ${String(error)}`) }
  }
  if (tempRoot) {
    try {
      const home = await realpath(homedir())
      const candidate = resolve(tempRoot)
      const part = relative(home, candidate)
      if (!part.startsWith('.dsh-python-built-smoke-') || part.includes(sep) || isAbsolute(part)) throw new Error('temporary fixture path is outside the allocated home prefix')
      const info = await lstat(candidate)
      if (!info.isDirectory() || info.isSymbolicLink() || await realpath(candidate) !== candidate) throw new Error('temporary fixture is not a real allocated directory')
      await rm(candidate, { recursive: true, force: false })
    } catch (error) { report.errors.push(`fixture cleanup: ${String(error)}`) }
  }
  report.status = report.errors.length === 0 ? layoutOnly ? 'layout-only-success' : 'success' : 'failed'
  await mkdir(resolve(reportPath, '..'), { recursive: true })
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`)
}
if (report.status !== 'success' && report.status !== 'layout-only-success') process.exitCode = 1
