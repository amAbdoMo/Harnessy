import { appendFile, mkdir, rename, stat, unlink } from 'node:fs/promises'
import { resolve } from 'node:path'

const DEFAULT_MAX_BYTES = 1024 * 1024
const DEFAULT_ARCHIVES = 3

async function removeIfPresent(path) {
  try {
    await unlink(path)
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
}

async function renameIfPresent(source, destination) {
  try {
    await rename(source, destination)
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
}

async function fileSize(path) {
  try {
    return (await stat(path)).size
  } catch (error) {
    if (error?.code === 'ENOENT') return 0
    throw error
  }
}

async function rotate(path, archives) {
  await removeIfPresent(`${path}.${String(archives)}`)
  for (let index = archives - 1; index >= 1; index -= 1) {
    await renameIfPresent(`${path}.${String(index)}`, `${path}.${String(index + 1)}`)
  }
  await renameIfPresent(path, `${path}.1`)
}

/** Create a serialized, size-bounded desktop diagnostic log. */
export function createDesktopLog(directory, options = {}) {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES
  const archives = options.archives ?? DEFAULT_ARCHIVES
  const sanitize = options.sanitize ?? (value => value)
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new Error('desktop log maxBytes must be positive')
  if (!Number.isSafeInteger(archives) || archives <= 0) throw new Error('desktop log archives must be positive')
  const path = resolve(directory, 'desktop.log')
  let pending = Promise.resolve()
  let lastError

  return {
    path,
    write(value) {
      const encoded = Buffer.from(sanitize(String(value)), 'utf8')
      let start = Math.max(0, encoded.length - maxBytes)
      while (start < encoded.length && (encoded[start] & 0xc0) === 0x80) start += 1
      const output = encoded.subarray(start)
      pending = pending.then(async () => {
        await mkdir(directory, { recursive: true })
        if (await fileSize(path) + output.length > maxBytes) await rotate(path, archives)
        await appendFile(path, output)
      }).catch(error => { lastError = error })
    },
    async flush() {
      await pending
      if (lastError !== undefined) throw lastError
    },
  }
}
