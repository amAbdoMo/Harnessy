import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { resolve } from 'node:path'

const SECRET_PATTERNS = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u,
  /\bAKIA[0-9A-Z]{16}\b/u,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/u,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/u,
  /\bsk-[A-Za-z0-9_-]{20,}\b/u,
]

async function filesBelow(root) {
  const results = []
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name)
      if (entry.isDirectory()) await visit(path)
      else if (entry.isFile()) results.push(path)
    }
  }
  await visit(root)
  return results.sort()
}

async function fileViolations(path, relative, forbiddenPaths) {
  const violations = new Set()
  const overlapLength = Math.max(256, ...forbiddenPaths.map(forbiddenPath => forbiddenPath.length))
  let overlap = ''
  for await (const chunk of createReadStream(path)) {
    const content = `${overlap}${chunk.toString('utf8')}`
    for (const pattern of SECRET_PATTERNS) {
      if (pattern.test(content)) violations.add(`${relative}: possible secret (${pattern.source})`)
    }
    for (const forbiddenPath of forbiddenPaths) {
      if (content.toLocaleLowerCase('en-US').includes(forbiddenPath.toLocaleLowerCase('en-US'))) {
        violations.add(`${relative}: contains developer path`)
      }
    }
    overlap = content.slice(-overlapLength)
  }
  return [...violations]
}

export async function scanDistributable(root, forbiddenPaths = []) {
  const violations = []
  for (const path of await filesBelow(root)) {
    const relative = path.slice(resolve(root).length + 1)
    if (/(?:^|[\\/])(?:\.env|\.git)(?:[\\/]|$)/iu.test(relative)) {
      violations.push(`${relative}: forbidden private file`)
      continue
    }
    violations.push(...await fileViolations(path, relative, forbiddenPaths.filter(Boolean)))
  }
  return violations
}

export async function sha256File(path) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}
