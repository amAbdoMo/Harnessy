import { defineConfig } from 'vitest/config'

export default defineConfig({
  root: import.meta.dirname,
  resolve: { dedupe: ['react', 'react-dom'] },
  test: { include: ['tests/**/*.spec.{ts,tsx}'], exclude: ['tests/service-script.spec.ts', 'tests/docs.spec.ts', 'tests/class-docs.spec.ts', ...(process.platform === 'win32' ? ['tests/environment.spec.ts', 'tests/deployment.spec.ts'] : [])] },
})
