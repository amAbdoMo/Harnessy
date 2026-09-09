import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { scanDistributable, sha256File } from '../src/package-verification.js'

test('rejects secret material and developer paths in distributable files', async t => {
  const root = await mkdtemp(join(tmpdir(), 'custom-harness-artifact-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await writeFile(join(root, 'safe.txt'), 'Custom Harness')
  const developerPath = 'C:\\Users\\Developer\\repo'
  const prefix = `source ${developerPath} `
  const boundaryPadding = `${'x'.repeat(65_529 - Buffer.byteLength(prefix))} `
  await writeFile(join(root, 'bad.txt'), `${prefix}${boundaryPadding}ghp_12345678901234567890`)
  const violations = await scanDistributable(root, [developerPath])
  assert.equal(violations.length, 2)
  assert.match(violations.join('\n'), /possible secret/u)
  assert.match(violations.join('\n'), /developer path/u)
})

test('rejects private metadata directories and computes stable checksums', async t => {
  const root = await mkdtemp(join(tmpdir(), 'custom-harness-artifact-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, '.git'))
  const privateFile = join(root, '.git', 'config')
  await writeFile(privateFile, 'private')
  assert.deepEqual(await scanDistributable(root), ['.git\\config: forbidden private file'])
  assert.equal(await sha256File(privateFile), '715dc8493c36579a5b116995100f635e3572fdf8703e708ef1a08d943b36774e')
})
