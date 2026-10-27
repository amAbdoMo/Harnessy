/** Bounded POSIX integration snapshot evidence checks. */

/** One Vitest assertion in a selected-owner report. */
export interface OwnerAssertion { fullName?: string; title?: string; status: string }
/** Minimal Vitest result fields used to validate selected owners. */
export interface OwnerReport { success: boolean; numFailedTests: number; numFailedTestSuites: number; numPassedTests: number; testResults: { assertionResults?: OwnerAssertion[] }[] }
/**
 * Identify a reviewable output in the selected owners.
 * @param path - Repository-relative path.
 * @param selection - Primary integration checks or the closed directory-fixtures selection.
 * @returns Whether the path is an allowed output.
 */
export function isAllowedOutput(path: string, selection?: string): boolean
/**
 * Hash a tracked file or link while refusing linked ancestors and Session inputs.
 * @param root - Repository root.
 * @param relativePath - Repository-relative path.
 * @returns File digest or tagged link-target digest.
 */
export function digestTracked(root: string, relativePath: string): Promise<string>
/**
 * Record hashes of tracked snapshots before running the owners.
 * @param root - Repository root.
 * @param evidence - Evidence directory.
 * @param selection - Primary integration checks or the closed directory-fixtures selection.
 * @returns Source revision and tracked snapshot hashes.
 */
export function freezeSnapshotInputs(root: string, evidence: string, selection?: string): Promise<{
  sourceHead: string
  selection: string
  baseline: Record<string, string>
}>
/**
 * Require each selected owner to have one passing assertion.
 * @param report - Vitest JSON report.
 * @param owners - Expected scenario names.
 * @param verb - Refresh or replay mode.
 */
export function checkOwnerReport(report: OwnerReport, owners: string[], verb: string): void
/**
 * Verify protected inputs and collect selected outputs and reports.
 * @param root - Repository root.
 * @param evidence - Evidence directory.
 * @param outcomes - Hosted step outcomes.
 * @param selection - Primary integration checks or the closed directory-fixtures selection.
 * @returns Qualification result.
 */
export function captureIntegrationEvidence(root: string, evidence: string, outcomes: Record<string, string | undefined>, selection?: string): Promise<{
  qualified: boolean
  selection: string
  ownerReports: Record<string, Record<string, string>>
  errors: string[]
}>
