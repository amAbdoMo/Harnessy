import { createElectronBuilderConfig } from './electron-builder.config-factory.mjs'

export default createElectronBuilderConfig(
  process.env,
  process.platform,
  process.arch,
  'local-unsigned',
)
