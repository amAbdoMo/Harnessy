/** Typed inputs and evidence records for the manual Python snapshot qualification helper. */

/** Hosted platforms admitted by this qualification phase. */
export type SnapshotPlatform = 'linux' | 'macos'
/** Actions step outcomes retained in the evidence report. */
export type SnapshotOutcome = 'success' | 'failure' | 'skipped' | 'cancelled'
/** Independently reported native qualification steps. */
export type SnapshotPhaseName = 'refresh' | 'replay' | 'builtPackageSmoke'

/** Private checkout roots and pinned input readers used during preparation. */
export interface SnapshotPhaseOptions {
  readonly repoRoot: string
  readonly phaseRoot: string
  readonly platform: SnapshotPlatform
  readonly sourceCommit?: string
  readonly expectedCommit?: string
  readonly readBlob?: (commit: string, path: string) => Uint8Array | Promise<Uint8Array>
  readonly sourceHashes?: ReadonlyMap<string, string>
  readonly turnManifestHash?: string
}

/** Original bytes needed to restore one existing header sidecar. */
export interface SnapshotSidecarBackup {
  readonly name: string
  readonly bytesBase64: string
  readonly sha256: string
}

/** Preparation journal and observed output inventory for an owned temporary phase. */
export interface SnapshotPhaseState {
  readonly schemaVersion: 1
  readonly platform: SnapshotPlatform
  readonly sourceCommit: string
  readonly sourceBlobs: Readonly<Record<string, { readonly sha256: string; readonly bytesBase64: string }>>
  readonly frozenBefore: Readonly<Record<string, string>>
  readonly original: {
    readonly turnManifestBase64: string
    readonly turnManifestSha256: string
    readonly compositionFiles: Readonly<Record<string, string>>
    readonly sidecars: readonly SnapshotSidecarBackup[]
  }
  readonly injected: {
    readonly turnManifestSha256: string
    readonly readOnlyManifestSha256: string
    readonly turnSessionSha256: string
    readonly readOnlySessionSha256: string
    readonly createdTurnFiles: readonly string[]
    readonly createdReadOnlyFiles: readonly string[]
  }
  readonly observed?: {
    readonly turn: readonly { readonly path: string; readonly sha256: string }[]
    readonly readOnly: readonly { readonly path: string; readonly sha256: string }[]
  }
  readonly captureComplete?: boolean
  readonly prepareError?: string
  readonly readOnlyCreated?: readonly string[]
}

/** Checkout, report destinations, and independently observed step outcomes. */
export interface SnapshotCaptureOptions {
  readonly repoRoot: string
  readonly phaseRoot: string
  readonly platform: SnapshotPlatform
  readonly outcomes?: Partial<Record<SnapshotPhaseName, SnapshotOutcome>>
  readonly readBlob?: (commit: string, path: string) => Uint8Array | Promise<Uint8Array>
}

/** One captured output's relative path, digest, and byte count. */
export interface SnapshotCapturedFile {
  readonly path: string
  readonly sha256: string
  readonly bytes: number
}

/** Complete output inventory captured from one temporary snapshot owner. */
export interface SnapshotOwnerOutputs {
  readonly files: readonly SnapshotCapturedFile[]
  readonly inventory: readonly string[]
}

/** Qualification result with immutable-input and current-writer evidence. */
export interface SnapshotCaptureReport {
  readonly schemaVersion: 1
  readonly status: 'captured' | 'capture-errors' | 'not-prepared'
  readonly platform: SnapshotPlatform
  readonly sourceCommit?: string
  readonly outcomes: Readonly<Record<SnapshotPhaseName, SnapshotOutcome>>
  readonly builtPackageSmoke?: {
    readonly status?: string
    readonly checks?: readonly string[]
    readonly errors?: readonly string[]
  }
  readonly qualified: boolean
  readonly sourceBlobs?: Readonly<Record<string, {
    readonly before: string
    readonly after: string
    readonly stagedInputAfter?: string
  }>>
  readonly compositionFiles?: {
    readonly before: Readonly<Record<string, string>>
    readonly afterSnapshotRuns: Readonly<Record<string, string | undefined>>
  }
  readonly frozenGenerations?: {
    readonly before: Readonly<Record<string, string>>
    readonly afterSnapshotRuns: Readonly<Record<string, string>>
  }
  readonly owners?: Readonly<{
    'ptc-python-turn': SnapshotOwnerOutputs
    'ptc-python-read-only': SnapshotOwnerOutputs
  }>
  readonly errors?: readonly string[]
}

/** Cleanup result that records whether original source files were retained. */
export interface SnapshotRestoreReport {
  readonly schemaVersion: 1
  readonly status: 'restored' | 'restore-errors' | 'not-prepared'
  readonly platform: SnapshotPlatform
  readonly restored: boolean
  readonly turnManifestSha256Before?: string
  readonly turnManifestSha256After?: string
  readonly compositionFiles?: {
    readonly before: Readonly<Record<string, string>>
    readonly afterCleanup: Readonly<Record<string, string>>
  }
  readonly frozenGenerations?: {
    readonly before: Readonly<Record<string, string>>
    readonly afterCleanup?: Readonly<Record<string, string>>
  }
  readonly readOnlyScenarioRemoved?: boolean
  readonly errors?: readonly string[]
}

/** Successful native execution evidence, excluding layout-only checks. */
export interface NativeBuiltSmokeEvidence {
  readonly status: 'success'
  readonly checks: readonly string[]
  readonly errors: readonly string[]
}

/** Exact upstream tree supplying the two immutable Python recordings. */
export const UPSTREAM_FIXTURE_COMMIT: string
/**
 * Hash tracked Session generations without following fixture links.
 * @param repoRoot - Checkout whose committed inputs are protected.
 * @returns Digests indexed by checkout-relative paths.
 */
export function frozenGenerations(repoRoot: string): Promise<Record<string, string>>
/**
 * Require both selected Python owners to pass in a real Vitest report.
 * @param bytes - Serialized Vitest JSON report.
 * @param label - Phase name used in failure messages.
 */
export function assertSnapshotRunnerReport(bytes: Uint8Array, label: string): void
/**
 * Require execution and confinement evidence from the built public package.
 * @param bytes - Serialized built-package smoke report.
 * @returns Validated native smoke evidence.
 */
export function assertNativeBuiltSmokeReport(bytes: Uint8Array): NativeBuiltSmokeEvidence
/**
 * Stage only the pinned temporary Python owners and save original bytes.
 * @param options - Checkout roots and pinned input readers.
 * @returns The preparation journal.
 */
export function prepareSnapshotInputs(options: SnapshotPhaseOptions): Promise<SnapshotPhaseState>
/**
 * Capture writer outputs and verify source-input preservation.
 * @param options - Report destinations and observed step outcomes.
 * @returns Qualification evidence with any detected errors.
 */
export function captureSnapshotOutputs(options: SnapshotCaptureOptions): Promise<SnapshotCaptureReport>
/**
 * Restore only files whose phase ownership and current digests are known.
 * @param options - Checkout and phase-journal locations.
 * @returns Cleanup evidence, retaining unexplained changes for diagnosis.
 */
export function restoreSnapshotInputs(options: Pick<SnapshotPhaseOptions, 'repoRoot' | 'phaseRoot' | 'platform'>): Promise<SnapshotRestoreReport>
/**
 * Refuse preparation outside a manually selected fork staging job.
 * @param env - GitHub Actions environment to validate.
 */
export function requireManualStagingCi(env: Readonly<Record<string, string | undefined>>): void

/** Verify the cleanup receipt against the restored checkout.
 * @param options - Checkout, phase location, platform, and optional fixture baseline.
 * @returns The verified cleanup receipt.
 */
export function verifyCleanup(options: Pick<SnapshotPhaseOptions, 'repoRoot' | 'phaseRoot' | 'platform' | 'turnManifestHash'>): Promise<SnapshotRestoreReport>
