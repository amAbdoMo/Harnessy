import { app } from 'electron'
import { packagedDesktopEnvironment } from './packaged-environment.js'

if (app.isPackaged) Object.assign(process.env, packagedDesktopEnvironment(process.resourcesPath))
await import('./main.js')
