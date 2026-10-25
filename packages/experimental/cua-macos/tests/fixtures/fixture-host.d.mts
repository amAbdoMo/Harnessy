/** Start the private native protocol substitute without accessing the desktop.
 * @param helperPath Test-owned executable copy.
 * @returns Cleanup that awaits every owned service exit.
 */
export function startFixtureHost(helperPath: string): Promise<() => Promise<void>>
