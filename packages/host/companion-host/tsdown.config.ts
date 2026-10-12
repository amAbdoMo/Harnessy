import { defineConfig } from 'tsdown'

/** Emit the Host provider and private Desktop control parser as closed, independent Node artifacts. */
export default defineConfig({
  entry: {
    index: 'lib/types/index.js',
    'desktop-control': 'lib/types/desktop-control.js',
  },
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
  codeSplitting: false,
})
