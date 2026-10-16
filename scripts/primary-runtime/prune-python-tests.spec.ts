import { createHash } from 'node:crypto'
import { lstatSync, unlinkSync } from 'node:fs'
import { link as hardlink, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { zipSync } from 'fflate'
import { expect, it } from 'vitest'
import { unpackPrimaryRuntimeWheel } from './prepare.ts'
import { prunePrimaryRuntimePythonTests } from './prune-python-tests.ts'
import lock from './lock.json' with { type: 'json' }

const records = {
  numpy: `numpy-${lock.pythonPackages.numpy}.dist-info/RECORD`,
  pandas: `pandas-${lock.pythonPackages.pandas}.dist-info/RECORD`,
}

async function fixture(run: (paths: {
  root: string
  staging: string
  sitePackages: string
  link: (target: string, path: string) => Promise<void>
}) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'primary-python-pruning-'))
  const staging = join(root, 'stage'), sitePackages = join(staging, 'payload', 'site-packages')
  const links: string[] = []
  try {
    for (const [name, record] of Object.entries(records)) {
      await mkdir(join(sitePackages, name, 'tests'), { recursive: true })
      await mkdir(dirname(join(sitePackages, record)), { recursive: true })
      await writeFile(join(sitePackages, name, 'tests', 'test_sample.py'), `${name} test\n`)
      await writeFile(join(sitePackages, record), `${name}/tests/test_sample.py,,\n${record},,\n`)
    }
    await run({ root, staging, sitePackages, link: async (target, path) => {
      await symlink(target, path, process.platform === 'win32' ? 'junction' : 'dir')
      links.push(path)
    } })
  } finally {
    for (const path of links) {
      let stat
      try { stat = lstatSync(path) } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        continue // Pruning may have unlinked a junction inside a removed real test directory.
      }
      if (stat.isSymbolicLink()) unlinkSync(path)
    }
    await rm(root, { recursive: true, force: true })
  }
}

it('prunes only NumPy/pandas test directories while retaining helpers, extensions, licenses and hashes', async () => {
  await fixture(async ({ root, sitePackages, staging }) => {
    const removed = [
      'numpy/tests/test_sample.py', 'numpy/_core/tests/test_core.py', 'numpy/_core/tests/data/values,small.csv',
      'numpy/testing/tests/test_utils.py', 'pandas/tests/test_sample.py', 'pandas/tests/io/data/workbook.xlsx',
    ]
    const retained = [
      'numpy/__init__.py', 'numpy/_core/_multiarray_tests.so', 'numpy/_core/_multiarray_tests.pyd',
      'numpy/testing/__init__.py', 'numpy/_core/tests.py', 'numpy/data/values,small.csv',
      'numpy/tests_extra/test_keep.py', 'pandas/__init__.py', 'pandas/testing.py',
      'pandas/_testing/__init__.py', 'pandas/_libs/testing.pyd',
      `${dirname(records.numpy)}/licenses/LICENSE.txt`, `${dirname(records.pandas)}/LICENSE`,
      'other/tests/test_other.py', 'numpy_extra/tests/test_extra.py',
    ]
    const files = Object.fromEntries([...removed, ...retained].map(path => [path, Buffer.from(`contents of ${path}\n`)]))
    const row = (path: string): string => `"${path}",sha256=${createHash('sha256').update(files[path]!).digest('base64url')},${files[path]!.length}\n`
    for (const [name, record] of Object.entries(records)) {
      const paths = [...removed, ...retained].filter(path => path.startsWith(`${name}/`) || path.startsWith(`${name}-`))
      files[record] = Buffer.from(`${paths.map(row).join('')}${record},,\n`)
    }
    files['other-1.0.dist-info/RECORD'] = Buffer.from('other/tests/test_other.py,,\n')
    const archive = join(root, 'libraries.whl'), wheel = Buffer.from(zipSync(files))
    await writeFile(archive, wheel)
    await unpackPrimaryRuntimeWheel(archive, sitePackages)
    await mkdir(join(sitePackages, 'numpy/empty/tests'), { recursive: true })

    prunePrimaryRuntimePythonTests(sitePackages, staging)

    for (const path of [...removed, 'numpy/tests', 'numpy/empty/tests', 'pandas/tests']) {
      await expect(readFile(join(sitePackages, path))).rejects.toMatchObject({ code: 'ENOENT' })
    }
    for (const path of [...retained, 'other-1.0.dist-info/RECORD']) {
      expect(await readFile(join(sitePackages, path))).toEqual(files[path])
    }
    for (const [name, record] of Object.entries(records)) {
      const expected = retained.filter(path => path.startsWith(`${name}/`) || path.startsWith(`${name}-`))
        .map(path => path.includes(',') ? row(path) : row(path).replace(`"${path}"`, path)).join('')
      expect(await readFile(join(sitePackages, record), 'utf8')).toBe(`${expected}${record},,\n`)
    }
    expect(await readFile(archive)).toEqual(wheel)
    const before = await Promise.all(Object.values(records).map(record => readFile(join(sitePackages, record))))
    prunePrimaryRuntimePythonTests(sitePackages, staging)
    expect(await Promise.all(Object.values(records).map(record => readFile(join(sitePackages, record))))).toEqual(before)
  })
})

it('preserves CSV commas, escaped quotes, embedded newlines and external script rows', async () => {
  await fixture(async ({ sitePackages, staging }) => {
    const record = join(sitePackages, records.numpy)
    await writeFile(record, `numpy/tests/test_sample.py,,\r\n"numpy/data/a,""small""\n.csv",sha256=abc,42\r\n../../../bin/numpy-config,,\r\n${records.numpy},,\r\n`)
    prunePrimaryRuntimePythonTests(sitePackages, staging)
    expect(await readFile(record, 'utf8')).toBe(`"numpy/data/a,""small""\n.csv",sha256=abc,42\n../../../bin/numpy-config,,\n${records.numpy},,\n`)
  })
})

it.each(['"unterminated,,\n', 'numpy/tests/test_sample.py,\n', 'numpy/a,,,\n', '', ',,\n', '"numpy/a"junk,,\n'])(
  'rejects malformed RECORDs before deleting either library: %j', async (record) => {
    await fixture(async ({ sitePackages, staging }) => {
      await writeFile(join(sitePackages, records.pandas), record)
      expect(() => { prunePrimaryRuntimePythonTests(sitePackages, staging) }).toThrow('invalid wheel RECORD')
      for (const name of ['numpy', 'pandas']) {
        expect(await readFile(join(sitePackages, name, 'tests/test_sample.py'), 'utf8')).toBe(`${name} test\n`)
      }
    })
  },
)

it('rejects missing RECORDs before deleting either library', async () => {
  await fixture(async ({ sitePackages, staging }) => {
    await rm(join(sitePackages, records.pandas))
    expect(() => { prunePrimaryRuntimePythonTests(sitePackages, staging) }).toThrow()
    expect(await readFile(join(sitePackages, 'numpy/tests/test_sample.py'), 'utf8')).toBe('numpy test\n')
  })
})

it('never traverses linked test directories or linked package subtrees', async () => {
  await fixture(async ({ root, sitePackages, staging, link }) => {
    const external = join(root, 'external')
    await mkdir(join(external, 'tests'), { recursive: true })
    await writeFile(join(external, 'tests/keep.py'), 'outside staging\n')
    await mkdir(join(sitePackages, 'numpy/linked'), { recursive: true })
    await link(join(external, 'tests'), join(sitePackages, 'numpy/linked/tests'))
    await link(external, join(sitePackages, 'pandas/linked'))
    await link(external, join(sitePackages, 'numpy/tests/junction'))
    const record = join(sitePackages, records.numpy)
    await writeFile(record, `numpy/tests/test_sample.py,,\nnumpy/linked/tests/keep.py,,\n${records.numpy},,\n`)

    prunePrimaryRuntimePythonTests(sitePackages, staging)

    expect(await readFile(join(external, 'tests/keep.py'), 'utf8')).toBe('outside staging\n')
    expect(lstatSync(join(sitePackages, 'numpy/linked/tests')).isSymbolicLink()).toBe(true)
    expect(lstatSync(join(sitePackages, 'pandas/linked')).isSymbolicLink()).toBe(true)
    expect(await readFile(record, 'utf8')).toBe(`numpy/linked/tests/keep.py,,\n${records.numpy},,\n`)
    await expect(readFile(join(sitePackages, 'numpy/tests/test_sample.py'))).rejects.toMatchObject({ code: 'ENOENT' })
  })
})

it.each(['numpy', dirname(records.pandas), 'payload'])(
  'rejects linked staging components before deletion: %s', async (component) => {
    await fixture(async ({ root, sitePackages, staging, link }) => {
      const original = component === 'payload' ? dirname(sitePackages) : join(sitePackages, component)
      const external = join(root, 'external')
      await mkdir(external)
      await writeFile(join(external, 'sentinel'), 'outside staging\n')
      await rm(original, { recursive: true })
      await link(external, original)
      expect(() => { prunePrimaryRuntimePythonTests(sitePackages, staging) }).toThrow('expected unlinked staged directory')
      expect(await readFile(join(external, 'sentinel'), 'utf8')).toBe('outside staging\n')
    })
  },
)

it('rejects a hardlinked RECORD before deletion or rewriting shared bytes', async () => {
  await fixture(async ({ root, sitePackages, staging }) => {
    const record = join(sitePackages, records.pandas)
    const external = join(root, 'external-record')
    const original = await readFile(record)
    await writeFile(external, original)
    await rm(record)
    await hardlink(external, record)
    expect(() => { prunePrimaryRuntimePythonTests(sitePackages, staging) }).toThrow('expected private staged wheel RECORD')
    expect(await readFile(external)).toEqual(original)
    expect(await readFile(join(sitePackages, 'numpy/tests/test_sample.py'), 'utf8')).toBe('numpy test\n')
  })
})

it.each(['staging-root', 'package-directory'])(
  'rejects a pruning root that is not a staged site-packages directory: %s', async (kind) => {
    await fixture(async ({ sitePackages, staging }) => {
      const path = kind === 'staging-root' ? staging : join(sitePackages, 'numpy')
      expect(() => { prunePrimaryRuntimePythonTests(path, staging) }).toThrow('expected staged site-packages')
      expect(await readFile(join(sitePackages, 'numpy/tests/test_sample.py'), 'utf8')).toBe('numpy test\n')
    })
  },
)

it('rejects site-packages outside private staging', async () => {
  await fixture(async ({ root, sitePackages }) => {
    const differentStaging = join(root, 'another-stage')
    await mkdir(differentStaging)
    expect(() => { prunePrimaryRuntimePythonTests(sitePackages, differentStaging) }).toThrow('outside private staging')
    expect(await readFile(join(sitePackages, 'numpy/tests/test_sample.py'), 'utf8')).toBe('numpy test\n')
  })
})
