/** Load platform-local release settings without changing the caller's process environment. */

/**
 * Signing behaviour one packaging run selects.
 * `signed` releases sign every artifact before it is recorded; `local-unsigned` builds a
 * developer-only Installer under the unsigned artifact directory; `release-unsigned` builds the
 * production installer set for GitHub distribution without Authenticode signing.
 */
export type DesktopPackageSignatureMode = 'signed' | 'local-unsigned' | 'release-unsigned'

/**
 * Read the target's required UTF-8 dotenv file; release settings never fall back to ambient values.
 * @param platform Target platform.
 * @param environment Parent environment, retained only for unrelated build tools.
 * @param appRoot Desktop application directory; relative credential paths resolve here.
 * @returns Isolated environment with file-owned release settings.
 */
export function loadDesktopPackageEnvironment(
  platform: 'win32' | 'darwin',
  environment?: NodeJS.ProcessEnv,
  appRoot?: string,
): NodeJS.ProcessEnv

/**
 * Validate release configuration before preparation without invoking a token or Apple's services.
 * @param environment File-owned release settings.
 * @param target Selected release target.
 * @param options Explicit packaging mode; `signatureMode` defaults to `signed`.
 * @returns Nothing.
 */
export function validateDesktopPackageEnvironment(
  environment: NodeJS.ProcessEnv,
  target: { platform: 'win32' | 'darwin', arch: string },
  options?: { signatureMode?: DesktopPackageSignatureMode, prepareOnly?: boolean },
): void
