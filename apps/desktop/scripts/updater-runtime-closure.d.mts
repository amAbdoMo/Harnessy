/** One package of the auto-updater's runtime closure. */
export interface UpdaterRuntimePackage {
  /** Package name as the updater requires it. */
  name: string
  /** Absolute directory of the installed package. */
  directory: string
}

/**
 * Collect the auto-updater's runtime packages and their transitive dependencies.
 * @param appDirectory Desktop application directory owning the install.
 * @returns Closure members ordered by name.
 */
export function updaterRuntimeClosure(appDirectory: string): UpdaterRuntimePackage[]

/**
 * Copy the closure into a staging directory inside the application directory.
 * @param closure Closure members to stage.
 * @param stagingDirectory Empty directory that receives one package per member.
 * @returns Staged closure members.
 */
export function stageUpdaterRuntimeClosure(
  closure: UpdaterRuntimePackage[], stagingDirectory: string,
): UpdaterRuntimePackage[]

/**
 * Reject a packaged application whose archive omits an updater runtime package.
 * @param archive Packaged archive reader.
 * @param closure Closure members the archive must contain.
 * @returns Nothing; a missing member throws.
 */
export function verifyUpdaterRuntimeClosure(
  archive: { getFile: (path: string, followLinks: boolean) => { size: number } | undefined },
  closure: { name: string }[],
): void
