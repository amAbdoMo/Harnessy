import expected from '../../../../vitest.expected.config.ts'

/** Owner-local runner until the repository expected lane includes SDK owners. */
export default {
  ...expected,
  test: { ...expected.test, include: ['packages/sdk/client/tests/directory.expected.e2e.ts'] },
}
