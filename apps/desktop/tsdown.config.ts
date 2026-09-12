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
    entry: ['lib/types/preload.js'],
    outDir: 'lib',
    format: ['cjs'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    // Electron's sandboxed preload loader cannot require Rolldown shared chunks.
    // Keep both bridges self-contained so contextBridge is always installed.
    outputOptions: { codeSplitting: false },
    dts: false,
    clean: false,
    deps: { neverBundle: ['electron'] },
  },
  {
    // A separate single-entry build prevents a shared chunk that sandboxed preload code cannot load.
    entry: ['lib/types/preload-app.js'],
    outDir: 'lib',
    format: ['cjs'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    outputOptions: { codeSplitting: false },
    dts: false,
    clean: false,
    deps: { neverBundle: ['electron'] },
  },
])
