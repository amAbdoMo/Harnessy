/** Experimental-package publication and dependency constraints. */

import { describe, expect, it } from 'vitest'
import {
  checkDshFamilyVersion,
  checkExperimentalDependencyIsolation,
  checkExperimentalManifest,
  checkWorkspaceManifest,
  expectedDshPackageFiles,
  type WorkspaceManifest,
} from './check-workspace-constraints.ts'

const experimental: WorkspaceManifest = {
  dir: 'packages/experimental/prototype',
  manifest: { name: '@deepseek-ai/dsh-experimental-prototype', private: true },
}

describe('experimental workspace constraints', () => {
  it('requires the experimental package-name prefix', () => {
    expect(checkExperimentalManifest({
      ...experimental,
      manifest: { ...experimental.manifest, name: '@deepseek-ai/dsh-prototype' },
    })).toEqual([
      '@deepseek-ai/dsh-prototype: experimental package name must start with "@deepseek-ai/dsh-experimental-"',
    ])
  })

  it('requires private manifests without publication metadata', () => {
    expect(checkExperimentalManifest(experimental)).toEqual([])
    expect(checkExperimentalManifest({
      ...experimental,
      manifest: { ...experimental.manifest, private: false, publishConfig: { access: 'public' } },
    })).toEqual([
      '@deepseek-ai/dsh-experimental-prototype: experimental package must set "private": true',
      '@deepseek-ai/dsh-experimental-prototype: experimental package must omit publishConfig',
    ])
  })

  it.each(['dependencies', 'optionalDependencies', 'peerDependencies'] as const)(
    'rejects release %s on an experimental package',
    (section) => {
      expect(checkExperimentalDependencyIsolation([experimental, {
        dir: 'packages/core/consumer',
        manifest: {
          name: '@deepseek-ai/dsh-consumer',
          [section]: { '@deepseek-ai/dsh-experimental-prototype': 'workspace:^' },
        },
      }])).toEqual([
        `@deepseek-ai/dsh-consumer: ${section}.@deepseek-ai/dsh-experimental-prototype must not reference an experimental package`,
      ])
    },
  )

  it('allows development and experimental consumers but rejects the Python release runtime', () => {
    const manifests: WorkspaceManifest[] = [experimental, {
      dir: 'packages/core/test-only',
      manifest: {
        name: '@deepseek-ai/dsh-test-only',
        devDependencies: { '@deepseek-ai/dsh-experimental-prototype': 'workspace:^' },
      },
    }, {
      dir: 'packages/experimental/consumer',
      manifest: {
        name: '@deepseek-ai/dsh-experimental-consumer',
        dependencies: { '@deepseek-ai/dsh-experimental-prototype': 'workspace:^' },
      },
    }, {
      dir: 'python/sdk-runtime',
      manifest: {
        name: '@deepseek-ai/dsh-python-runtime',
        dependencies: { '@deepseek-ai/dsh-experimental-prototype': 'workspace:^' },
      },
    }]

    expect(checkExperimentalDependencyIsolation(manifests)).toEqual([
      '@deepseek-ai/dsh-python-runtime: dependencies.@deepseek-ai/dsh-experimental-prototype must not reference an experimental package',
    ])
  })
})

describe('dsh family version coherence', () => {
  it('rejects a package carrying a stale shared version', () => {
    expect(checkDshFamilyVersion(
      { name: '@deepseek-ai/dsh-http-proxy', version: '0.1.2-alpha.5' },
      '0.1.2-rc.1',
    )).toBe('@deepseek-ai/dsh-http-proxy: package.json version must match root version 0.1.2-rc.1')
  })

  it('rejects the root-named CLI app on a stale shared version', () => {
    expect(checkDshFamilyVersion(
      { name: '@deepseek-ai/dsh', version: '0.1.2-alpha.5' },
      '0.1.2-rc.1',
    )).toBe('@deepseek-ai/dsh: package.json version must match root version 0.1.2-rc.1')
  })

  it('accepts a manifest carrying the shared version', () => {
    expect(checkDshFamilyVersion(
      { name: '@deepseek-ai/dsh-http-proxy', version: '0.1.2-rc.1' },
      '0.1.2-rc.1',
    )).toBeUndefined()
  })

  it('leaves other sequences to their own version lines', () => {
    expect(checkDshFamilyVersion({ name: '@deepseek-ai/cordis', version: '4.0.1' }, '0.1.2-rc.1')).toBeUndefined()
    expect(checkDshFamilyVersion(
      { name: '@deepseek-ai/node-addon-system', version: '0.1.1' },
      '0.1.2-rc.1',
    )).toBeUndefined()
    expect(checkDshFamilyVersion({ version: '0.1.2-alpha.5' }, '0.1.2-rc.1')).toBeUndefined()
  })
})

describe('package payload constraints', () => {
  it('includes a declared profile patch without a package-name allowlist', () => {
    expect(expectedDshPackageFiles({
      name: '@deepseek-ai/dsh-private-profile',
      dsh: { bundle: { patch: './cordis.patch.yml' } },
    })).toEqual([
      'lib/index.js',
      'cordis.patch.yml',
      'lib/types/**/*.d.ts',
    ])
  })
})

const UPSTREAM_REPOSITORY = 'git+https://github.com/deepseek-ai/deepseek-harness.git'
const FORK_REPOSITORY = 'git+https://github.com/amAbdoMo/Harnessy.git'
/** A directory with an upstream counterpart, so the published source home is required. */
const UPSTREAM_MEMBER = 'packages/example/upstream-member'
/** A directory the fork owns outright, drawn from the explicit fork-local policy set. */
const FORK_MEMBER = 'packages/subagent/subagent-roster'

/**
 * A release member satisfying every constraint but the repository rule, so a
 * test can vary that one field and read only its outcome.
 * @param dir - workspace directory the manifest claims.
 * @param repository - repository metadata, or undefined to omit it entirely.
 * @returns the manifest under test.
 */
function releaseMember(
  dir: string,
  repository?: { readonly type: string; readonly url: string; readonly directory: string },
): WorkspaceManifest {
  return {
    dir,
    manifest: {
      name: '@deepseek-ai/dsh-example',
      version: '0.1.5-alpha.1',
      publishConfig: { access: 'public' },
      ...repository === undefined ? {} : { repository },
      type: 'module',
      main: 'lib/index.js',
      types: 'lib/types/index.d.ts',
      exports: { '.': { types: './lib/types/index.d.ts', default: './lib/index.js' } },
      files: ['lib/index.js', 'lib/types/**/*.d.ts'],
      peerDependencies: { '@deepseek-ai/cordis': 'workspace:^' },
      devDependencies: { '@deepseek-ai/cordis': 'workspace:^' },
    },
  }
}

/**
 * The repository-metadata outcome alone, with the checker's `<path>: ` prefix
 * removed so the expectation states the policy rather than a path separator.
 * @param errors - every error the checker reported for one manifest.
 * @returns the policy messages that concern repository metadata.
 */
function repositoryErrors(errors: readonly string[]): readonly string[] {
  return errors
    .filter(error => error.includes('repository'))
    .map(error => error.slice(error.indexOf(': ') + 2))
}

describe('release-member repository policy', () => {
  it('accepts a manifest that satisfies every other constraint', () => {
    expect(checkWorkspaceManifest(releaseMember(UPSTREAM_MEMBER, {
      type: 'git',
      url: UPSTREAM_REPOSITORY,
      directory: UPSTREAM_MEMBER,
    }))).toEqual([])
  })

  it('accepts an upstream member naming the published source home', () => {
    expect(repositoryErrors(checkWorkspaceManifest(releaseMember(UPSTREAM_MEMBER, {
      type: 'git',
      url: UPSTREAM_REPOSITORY,
      directory: UPSTREAM_MEMBER,
    })))).toEqual([])
  })

  it('rejects an upstream member naming the fork', () => {
    expect(repositoryErrors(checkWorkspaceManifest(releaseMember(UPSTREAM_MEMBER, {
      type: 'git',
      url: FORK_REPOSITORY,
      directory: UPSTREAM_MEMBER,
    })))).toEqual([
      `@deepseek-ai/dsh-example: release member repository must use ${UPSTREAM_REPOSITORY} with directory ${UPSTREAM_MEMBER}`,
    ])
  })

  it('accepts a fork-local member naming the fork', () => {
    expect(repositoryErrors(checkWorkspaceManifest(releaseMember(FORK_MEMBER, {
      type: 'git',
      url: FORK_REPOSITORY,
      directory: FORK_MEMBER,
    })))).toEqual([])
  })

  it('rejects a fork-local member naming the published source home', () => {
    expect(repositoryErrors(checkWorkspaceManifest(releaseMember(FORK_MEMBER, {
      type: 'git',
      url: UPSTREAM_REPOSITORY,
      directory: FORK_MEMBER,
    })))).toEqual([
      `@deepseek-ai/dsh-example: release member repository must use ${FORK_REPOSITORY} with directory ${FORK_MEMBER}`,
    ])
  })

  it('rejects a fork-local member naming an unrelated repository', () => {
    expect(repositoryErrors(checkWorkspaceManifest(releaseMember(FORK_MEMBER, {
      type: 'git',
      url: 'git+https://github.com/elsewhere/other.git',
      directory: FORK_MEMBER,
    })))).toEqual([
      `@deepseek-ai/dsh-example: release member repository must use ${FORK_REPOSITORY} with directory ${FORK_MEMBER}`,
    ])
  })

  it('rejects a release member with no repository metadata, in either category', () => {
    const expectedUpstream = `@deepseek-ai/dsh-example: release member repository must use ${UPSTREAM_REPOSITORY} with directory ${UPSTREAM_MEMBER}`
    const expectedFork = `@deepseek-ai/dsh-example: release member repository must use ${FORK_REPOSITORY} with directory ${FORK_MEMBER}`
    expect(repositoryErrors(checkWorkspaceManifest(releaseMember(UPSTREAM_MEMBER)))).toEqual([expectedUpstream])
    expect(repositoryErrors(checkWorkspaceManifest(releaseMember(FORK_MEMBER)))).toEqual([expectedFork])
  })

  it('rejects a repository naming the wrong directory for its own category', () => {
    expect(repositoryErrors(checkWorkspaceManifest(releaseMember(FORK_MEMBER, {
      type: 'git',
      url: FORK_REPOSITORY,
      directory: 'packages/subagent/somewhere-else',
    })))).toEqual([
      `@deepseek-ai/dsh-example: release member repository must use ${FORK_REPOSITORY} with directory ${FORK_MEMBER}`,
    ])
  })
})
