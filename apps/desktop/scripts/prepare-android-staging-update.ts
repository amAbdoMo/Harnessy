/** Prepare a signed debug APK delta for the Windows staging companion feed. */
import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, readFile, readdir, rename, rm, stat, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { parseArgs, promisify } from 'node:util'
import { gunzipSync } from 'node:zlib'
import { buildBlockMap } from 'app-builder-lib/out/targets/blockmap/blockmap.js'

const run = promisify(execFile)
const MAX_BYTES = 64 * 1024 * 1024
const MAX_OPERATIONS = 65_536
const APP_ID = 'io.harnessy.companion.debug'

interface Block {
  readonly offset: number
  readonly size: number
  readonly checksum: string
}

function sha256(bytes: Buffer): string { return createHash('sha256').update(bytes).digest('hex') }

async function boundedApk(path: string): Promise<Buffer> {
  const info = await stat(path)
  if (!info.isFile() || info.size < 1 || info.size > MAX_BYTES) throw new Error('Android APK size is unavailable or unsupported')
  const bytes = await readFile(path)
  if (bytes.length !== info.size) throw new Error('Android APK changed during preparation')
  return bytes
}

function mapBlocks(value: unknown, length: number): Block[] {
  if (typeof value !== 'object' || value === null || !('version' in value) || value.version !== '2'
    || !('files' in value) || !Array.isArray(value.files) || value.files.length !== 1) throw new Error('Invalid APK block map')
  const file: unknown = value.files[0]
  if (typeof file !== 'object' || file === null || !('sizes' in file) || !Array.isArray(file.sizes)
    || !('checksums' in file) || !Array.isArray(file.checksums) || file.sizes.length !== file.checksums.length
    || file.sizes.length > MAX_OPERATIONS) throw new Error('Invalid APK block list')
  const checksums: unknown[] = file.checksums
  let offset = 0
  const blocks = file.sizes.map((size: unknown, index) => {
    const checksum = checksums[index]
    if (typeof size !== 'number' || !Number.isSafeInteger(size) || size < 1 || offset + size > length
      || typeof checksum !== 'string') throw new Error('Invalid APK block')
    const block = { offset, size, checksum }
    offset += size
    return block
  })
  if (offset !== length) throw new Error('APK block map does not cover the file')
  return blocks
}

/**
 * Use electron-builder's content-defined blocks to encode old APK ranges and changed bytes.
 * @param basePath - installed signed APK bytes. @param targetPath - newer signed APK bytes.
 * @returns Exact base, target and byte-copy delta.
 */
export async function buildAndroidDelta(basePath: string, targetPath: string): Promise<{ base: Buffer; target: Buffer; patch: Buffer }> {
  const scratch = await mkdtemp(join(tmpdir(), 'harnessy-android-blocks-'))
  const oldMap = join(scratch, 'old.gz')
  const newMap = join(scratch, 'new.gz')
  try {
    const [base, target] = await Promise.all([boundedApk(basePath), boundedApk(targetPath)])
    await Promise.all([buildBlockMap(basePath, 'gzip', oldMap), buildBlockMap(targetPath, 'gzip', newMap)])
    const [previous, next] = await Promise.all([oldMap, newMap].map(async map => JSON.parse(gunzipSync(await readFile(map)).toString('utf8'))))
    const oldBlocks = new Map(mapBlocks(previous, base.length).map(block => [block.checksum, block]))
    const newBlocks = mapBlocks(next, target.length)
    const header = Buffer.alloc(8)
    header.write('HYD1', 0, 'ascii')
    header.writeUInt32BE(newBlocks.length, 4)
    const chunks: Buffer[] = [header]
    for (const block of newBlocks) {
      const bytes = target.subarray(block.offset, block.offset + block.size)
      const match = oldBlocks.get(block.checksum)
      const source = match !== undefined && match.size === block.size
        && bytes.equals(base.subarray(match.offset, match.offset + match.size)) ? match.offset : -1
      const record = Buffer.alloc(8)
      record.writeInt32BE(source, 0)
      record.writeUInt32BE(block.size, 4)
      chunks.push(record)
      if (source === -1) chunks.push(bytes)
    }
    return { base, target, patch: Buffer.concat(chunks) }
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
}

async function inspectApk(path: string, tools: string, java: string): Promise<{ versionCode: number; signer: string }> {
  const [{ stdout: badging }, { stdout: certificate }] = await Promise.all([
    run(join(tools, 'aapt.exe'), ['dump', 'badging', path], { windowsHide: true }),
    run(java, ['-jar', join(tools, 'lib', 'apksigner.jar'), 'verify', '--print-certs', path], { windowsHide: true }),
  ])
  const packageLine = /^package: name='([^']+)' versionCode='([0-9]+)'/m.exec(badging)
  const signers = [...certificate.matchAll(/^Signer #\d+ certificate SHA-256 digest: ([a-f\d]{64})\s*$/gim)]
  if (packageLine?.[1] !== APP_ID || signers.length !== 1 || signers[0]?.[1] === undefined) {
    throw new Error('Expected one verified signer and the Harnessy Dev package')
  }
  const versionCode = Number(packageLine[2])
  if (!Number.isSafeInteger(versionCode) || versionCode < 1 || versionCode > 2_100_000_000) throw new Error('Invalid Android version code')
  return { versionCode, signer: signers[0][1].toLowerCase() }
}

async function prepare(): Promise<void> {
  const { values } = parseArgs({ options: { base: { type: 'string' }, target: { type: 'string' } } })
  const { LOCALAPPDATA: appData, JAVA_HOME: jdk, ANDROID_HOME: sdk } = process.env
  if (process.platform !== 'win32' || appData === undefined || jdk === undefined || values.base === undefined || values.target === undefined) {
    throw new Error('Pass --base and --target on the staging PC with JAVA_HOME set to the Android JDK')
  }
  const basePath = resolve(values.base)
  const targetPath = resolve(values.target)
  const toolsRoot = join(sdk ?? join(appData, 'Android', 'Sdk'), 'build-tools')
  const installed = (await readdir(toolsRoot)).filter(name => /^\d+\.\d+\.\d+$/u.test(name))
  installed.sort((first, second) => second.localeCompare(first, 'en', { numeric: true }))
  if (installed[0] === undefined) throw new Error('Android build tools are unavailable')
  const tools = join(toolsRoot, installed[0])
  const java = join(jdk, 'bin', 'java.exe')
  const [previous, next] = await Promise.all([inspectApk(basePath, tools, java), inspectApk(targetPath, tools, java)])
  if (previous.signer !== next.signer || next.versionCode <= previous.versionCode) {
    throw new Error('Harnessy Dev updates require the same signer and a higher version code')
  }
  const { base, target, patch } = await buildAndroidDelta(basePath, targetPath)
  if (patch.length >= target.length) throw new Error('Android delta must be smaller than the complete APK')
  const directory = join(appData, 'CustomHarnessStaging', 'Harness', 'android-updates')
  await mkdir(directory, { recursive: true })
  const artifactId = sha256(patch)
  const baseSha256 = sha256(base)
  const offer = { artifactId, baseSha256, targetSha256: sha256(target), versionCode: next.versionCode,
    targetBytes: target.length, patchBytes: patch.length }
  const patchPath = join(directory, `${artifactId}.hyd`)
  await writeFile(patchPath, patch, { flag: 'wx' }).catch(async (error: NodeJS.ErrnoException) => {
    if (error.code !== 'EEXIST' || !(await boundedApk(patchPath)).equals(patch)) throw error
  })
  const temporary = join(directory, `${randomUUID()}.tmp`)
  try {
    await writeFile(temporary, `${JSON.stringify(offer)}\n`, { flag: 'wx' })
    await rename(temporary, join(directory, `${baseSha256}.json`))
  } finally {
    await unlink(temporary).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error })
  }
  console.log(`Android staging update ${previous.versionCode} → ${next.versionCode}: ${patch.length} of ${target.length} bytes.`)
}

if (import.meta.main) await prepare()
