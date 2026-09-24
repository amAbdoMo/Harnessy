import { isAbsolute, resolve } from 'node:path'

const DEFAULT_STARTUP_TIMEOUT_MS = 60_000
const DEFAULT_HEALTH_INTERVAL_MS = 2_000
const DEFAULT_HEALTH_FAILURE_LIMIT = 3

function required(environment, name) {
  const configuredValue = environment[name]
  if (configuredValue === undefined || configuredValue.trim() === '') {
    throw new Error(`Harnessy desktop requires ${name}`)
  }
  return configuredValue
}

function absolutePath(environment, name) {
  const configuredPath = required(environment, name)
  if (!isAbsolute(configuredPath)) throw new Error(`${name} must be an absolute path`)
  return resolve(configuredPath)
}

function positiveInteger(environment, name, fallback, maximum = Number.MAX_SAFE_INTEGER) {
  const raw = environment[name]
  if (raw === undefined || raw === '') return fallback
  const configuredNumber = Number(raw)
  if (!Number.isSafeInteger(configuredNumber) || configuredNumber <= 0 || configuredNumber > maximum) {
    throw new Error(`${name} must be a positive integer no greater than ${String(maximum)}`)
  }
  return configuredNumber
}

/** Resolve the explicit product/runtime boundary supplied by the source or packaged launcher. */
export function resolveDesktopConfig(environment = process.env) {
  return {
    appId: required(environment, 'CUSTOM_HARNESS_DESKTOP_APP_ID'),
    productName: required(environment, 'CUSTOM_HARNESS_PRODUCT_NAME'),
    profile: required(environment, 'CUSTOM_HARNESS_DESKTOP_PROFILE'),
    nodeExecutable: absolutePath(environment, 'CUSTOM_HARNESS_DESKTOP_NODE_EXECUTABLE'),
    dshEntry: absolutePath(environment, 'CUSTOM_HARNESS_DESKTOP_DSH_ENTRY'),
    jobLauncher: absolutePath(environment, 'CUSTOM_HARNESS_DESKTOP_JOB_LAUNCHER'),
    workingDirectory: absolutePath(environment, 'CUSTOM_HARNESS_DESKTOP_WORKING_DIRECTORY'),
    userData: absolutePath(environment, 'CUSTOM_HARNESS_DESKTOP_USER_DATA'),
    logDirectory: absolutePath(environment, 'CUSTOM_HARNESS_DESKTOP_LOG_DIR'),
    icon: absolutePath(environment, 'CUSTOM_HARNESS_DESKTOP_ICON'),
    port: positiveInteger(environment, 'CUSTOM_HARNESS_DESKTOP_PORT', 48_765, 65_535),
    startupTimeoutMs: positiveInteger(
      environment,
      'CUSTOM_HARNESS_DESKTOP_STARTUP_TIMEOUT_MS',
      DEFAULT_STARTUP_TIMEOUT_MS,
      10 * 60_000,
    ),
    healthIntervalMs: positiveInteger(
      environment,
      'CUSTOM_HARNESS_DESKTOP_HEALTH_INTERVAL_MS',
      DEFAULT_HEALTH_INTERVAL_MS,
      60_000,
    ),
    healthFailureLimit: positiveInteger(
      environment,
      'CUSTOM_HARNESS_DESKTOP_HEALTH_FAILURE_LIMIT',
      DEFAULT_HEALTH_FAILURE_LIMIT,
      30,
    ),
  }
}
