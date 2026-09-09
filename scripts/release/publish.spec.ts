import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { assertPublishablePackageSet } from './publish.ts'
import { releasePublicationDisabled } from './pack.ts'
import { PUBLISH_DISABLED_FILE } from './tarball.ts'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('release publication boundary', () => {
  it('classifies every release set containing the Custom Harness bundle as non-publishable', () => {
    expect(releasePublicationDisabled([{
      directory: 'packages/bundle/custom-harness',
      name: '@deepseek-ai/dsh-custom-harness',
      version: '1.0.0',
      manifest: {},
    }])).toBe(true)
  })

  it('rejects a Custom Harness package set before contacting the registry', () => {
    const root = mkdtempSync(join(tmpdir(), 'custom-harness-publish-'))
    roots.push(root)
    writeFileSync(join(root, PUBLISH_DISABLED_FILE), 'publication disabled\n')

    expect(() => { assertPublishablePackageSet(root) }).toThrow(/product-specific.*disabled/u)
  })
})
