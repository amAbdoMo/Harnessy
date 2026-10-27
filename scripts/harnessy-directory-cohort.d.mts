/** Evidence and validation interfaces for the manual Linux directory cohort. */

/** One exact Vitest case in the closed owner registry. */
export interface CohortCase { readonly file: string; readonly name: string }
/** Source bytes frozen before the first refresh. */
export interface CohortBaseline {
  readonly sourceHead: string
  readonly hashes: Record<string, string>
  readonly sessionInputs: Record<string, string>
}
/** Vitest JSON fields used to qualify selected cases. */
export interface CohortReport {
  readonly success: boolean
  readonly numFailedTests: number
  readonly numFailedTestSuites: number
  readonly testResults: readonly {
    readonly name: string
    readonly assertionResults: readonly { readonly fullName: string; readonly status: string }[]
  }[]
}
/** Frozen Session hashes and exact changed candidate output hashes. */
export interface CohortFiles {
  readonly outputs: Record<string, { readonly before: string | null; readonly sha256: string }>
  readonly sessionInputs: Record<string, { readonly before: string; readonly after: string }>
}
/** Require a nonempty exact list of selected case identifiers.
 * @param root - Repository root.
 * @param inventory - Actual Vitest list JSON.
 * @param expected - Closed expected case list.
 * @returns Unique normalized case identifiers.
 */
export function checkCohortInventory(root: string, inventory: readonly CohortCase[], expected: readonly CohortCase[]): string[]
/** Reject missing, duplicate, skipped, failed, or unexpectedly executed cases.
 * @param root - Repository root.
 * @param report - Actual Vitest JSON result.
 * @param selected - Strictly listed case identifiers.
 */
export function checkCohortReport(root: string, report: CohortReport, selected: readonly string[]): void
/** Freeze tracked source and every repository Session generation from a clean checkout.
 * @param root - Private checkout or CI repository root.
 * @param evidence - Fresh evidence directory.
 * @returns Frozen source and Session digests.
 */
export function freezeCohort(root: string, evidence: string): Promise<CohortBaseline>
/** Reject input/source mutations and outputs outside exact selected physical slots.
 * @param root - Repository root.
 * @param baseline - Frozen source and Session digests.
 * @param writable - Exact generated output paths.
 * @returns Observed output and Session digests.
 */
export function checkCohortFiles(root: string, baseline: CohortBaseline, writable: readonly string[]): Promise<CohortFiles>
