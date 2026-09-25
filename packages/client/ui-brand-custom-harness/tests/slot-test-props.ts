/**
 * Complete a focused component fixture whose omitted fields belong to the
 * surrounding slot runtime rather than the component behavior under test.
 * @param value - the component-specific props supplied by the test.
 * @returns the fixture typed as the complete slot-composed props.
 */
// oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- the caller names the framework-completed prop type.
export function slotTestProps<T>(value: object): T {
  return value as T
}
