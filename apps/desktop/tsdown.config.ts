import { resolve } from 'node:path'
import { defineConfig } from 'tsdown'

const productRuntime = resolve(import.meta.dirname, '../../scripts/custom-harness-product.mjs')

export default defineConfig([
  {
    entry: ['lib/types/main.js'],
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    clean: false,
    alias: {
      '../../../scripts/custom-harness-product.mjs': productRuntime,
    },
    deps: { neverBundle: ['electron'] },
  },
  {
    // Sandboxed Electron preloads run as CommonJS even though the application package is ESM.
    entry: {
      preload: 'lib/types/preload.js',
      'preload-app': 'lib/types/preload-app.js',
    },
    outDir: 'lib',
    format: ['cjs'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    clean: false,
    deps: { neverBundle: ['electron'] },
  },
])
