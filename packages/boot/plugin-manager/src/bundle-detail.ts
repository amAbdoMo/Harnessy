/** Detail documents and images of installed or installation-provided bundles, read from their local directories. */
import { resolveBundleDir } from '@deepseek-ai/dsh-app-boot'
import type { ProfileContext } from '@deepseek-ai/dsh-app-boot'
import {
  DetailFailure, detailImage, languageChain, localFiles, readPackageDocument,
  type DetailFiles,
} from '@deepseek-ai/dsh-plugin-detail'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import type { BundleDetail, BundleInfo } from './types.ts'

/** Limits and sources of bundle detail reads. */
export interface BundleDetailOptions {
  readonly profile: ProfileContext
  readonly maxDocumentBytes: number
  readonly maxImageBytes: number
  /** The plugin manager's disposal. */
  readonly lifetime: AbortSignal
}

/**
 * The files of a listed bundle: its local directory.
 * @param bundle - the bundle as `listBundles()` reports it.
 * @param options - profile, sources, and limits.
 * @returns the local files.
 * @throws {RemoteError} `plugin-manager/unknown-bundle` when the bundle's directory cannot be resolved.
 */
function filesOf(bundle: BundleInfo, options: BundleDetailOptions): DetailFiles {
  let dir: string
  try {
    dir = resolveBundleDir('dsh', bundle.name, options.profile.installAnchor, options.profile.dir)
  } catch (error) {
    throw new RemoteError('plugin-manager/unknown-bundle', (error as Error).message, { name: bundle.name }, { cause: error })
  }
  // `listBundles()` reports the version of every bundle whose manifest it read; one without is read as unversioned.
  return localFiles(dir, String(bundle.version))
}

/** Rethrow a detail failure as the Remote error clients read. */
function remoteFailure(error: unknown): never {
  if (error instanceof DetailFailure) {
    throw new RemoteError('plugin-manager/detail-unavailable', error.message, { reason: error.reason }, { cause: error })
  }
  throw error
}

/**
 * Read a bundle's detail document in a display language.
 * @param bundle - the bundle as `listBundles()` reports it.
 * @param language - a BCP 47 language id.
 * @param options - profile, sources, and limits.
 * @returns the document, or `none` when the bundle has neither a `meta.detail` file nor a README.
 * @throws {RemoteError} `plugin-manager/invalid-language`, `plugin-manager/unknown-bundle`, or
 *   `plugin-manager/detail-unavailable`.
 */
export async function readBundleDocument(
  bundle: BundleInfo, language: string, options: BundleDetailOptions,
): Promise<BundleDetail> {
  let languages: string[]
  try {
    languages = languageChain(language)
  } catch (error) {
    throw new RemoteError('plugin-manager/invalid-language', (error as Error).message, { language }, { cause: error })
  }
  const files = filesOf(bundle, options)
  const document = await readPackageDocument(files, '', languages, options.maxDocumentBytes, options.lifetime).catch(remoteFailure)
  return document === undefined ? { status: 'none' } : { status: 'found', ...document }
}

/**
 * Read an image beside a bundle's detail document.
 * @param bundle - the bundle as `listBundles()` reports it.
 * @param document - the document's path inside the bundle, as {@link readBundleDocument} returned it.
 * @param destination - the image destination as the document writes it.
 * @param options - profile, sources, and limits.
 * @returns the bytes and media type, or undefined for a path outside the bundle, an unsupported type, or a missing file.
 * @throws {RemoteError} `plugin-manager/unknown-bundle` or `plugin-manager/detail-unavailable`.
 */
export async function readBundleImage(
  bundle: BundleInfo, document: string, destination: string, options: BundleDetailOptions,
): Promise<{ bytes: Uint8Array; mediaType: string } | undefined> {
  const image = detailImage(document, destination)
  const files = image === undefined ? undefined : filesOf(bundle, options)
  if (image === undefined || files === undefined) return undefined
  const bytes = await files.read(image.path, options.maxImageBytes, options.lifetime).catch(remoteFailure)
  return bytes === undefined ? undefined : { bytes, mediaType: image.mediaType }
}
