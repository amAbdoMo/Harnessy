import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { test } from 'node:test'

function write(root, path, value) {
  const target = join(root, path)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, value)
}

function manifest(root) {
  const records = []
  const visit = directory => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) visit(path)
      else {
        assert.equal(entry.isFile(), true, `unsupported fixture entry: ${path}`)
        const body = readFileSync(path)
        records.push({
          path: relative(root, path).replaceAll('\\', '/'),
          bytes: statSync(path).size,
          sha256: createHash('sha256').update(body).digest('hex'),
        })
      }
    }
  }
  visit(root)
  return records.sort((left, right) => left.path.localeCompare(right.path))
}

test('cold backup and whole-generation rollback preserve representative product data', () => {
  const root = mkdtempSync(join(tmpdir(), 'custom-harness-phase10-'))
  const live = join(root, 'CustomHarness')
  const backup = join(root, 'pre-upgrade')
  const stage = join(root, 'restore-stage')
  const quarantine = join(root, 'failed-candidate')

  try {
    write(live, 'Harness/sessions/project/session/session.v2.jsonl', '{"type":"session","version":2}\n')
    write(live, 'Harness/attachments/v1/sha256/fixture', 'image-object')
    write(live, 'Harness/settings.yaml', 'ui:\n  locale: en\n')
    write(live, 'Harness/.credentials.yaml', 'version: 1\nrefs: {}\nrecords: {}\n')
    write(live, 'Harness/storages/workspace.json', '{"version":2,"data":{}}\n')
    write(live, 'Harness/storages/session_projcache/sessions/session.json', '{"version":5,"data":{}}\n')
    write(live, 'Harness/storages/message_feedback.json', '{"version":0,"data":{}}\n')
    write(live, 'Harness/profiles/custom-harness/package.json', '{"private":true}\n')
    write(live, 'Harness/.agent-presets/default/preset.yml', 'name: default\n')
    write(live, 'Harness/skills/home/SKILL.md', '# Home skill\n')
    write(live, 'Agents/skills/agent/SKILL.md', '# Agent skill\n')
    write(live, 'Harness/.anonymous-user-id', '00000000-0000-4000-8000-000000000000\n')
    write(live, 'Cache/DesktopUserData/Local Storage/leveldb/CURRENT', 'MANIFEST-000001\n')
    write(live, 'Logs/desktop.log', 'synthetic diagnostic\n')

    const before = manifest(live)
    cpSync(live, backup, { recursive: true, errorOnExist: true })
    assert.deepEqual(manifest(backup), before)

    write(live, 'Harness/sessions/project/session/session.v3.jsonl', '{"type":"session","version":3}\n')
    write(live, 'Harness/settings.yaml', 'ui:\n  locale: zh-CN\n')
    write(live, 'Cache/DesktopUserData/Local Storage/leveldb/000002.log', 'candidate-state')

    cpSync(backup, stage, { recursive: true, errorOnExist: true })
    assert.deepEqual(manifest(stage), before)
    renameSync(live, quarantine)
    renameSync(stage, live)

    assert.deepEqual(manifest(live), before)
    assert.equal(manifest(live).some(record => record.path.endsWith('session.v3.jsonl')), false)
    assert.equal(manifest(quarantine).some(record => record.path.endsWith('session.v3.jsonl')), true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
