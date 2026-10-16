/**
 * Whether this Safe's data is being served by the development-only mock.
 *
 * Reads a global the mock sets rather than importing it, so the production
 * bundle keeps no reference to that module at all. `import.meta.env.DEV` is
 * replaced with `false` in a production build, so this collapses to a constant
 * `false` and every caller's branch is eliminated.
 */
export function isSimulatedSafe(address: string | undefined): boolean {
  if (!import.meta.env.DEV) return false;
  const mocked = window.__safeApiMockAddress;
  return !!mocked && !!address && mocked.toLowerCase() === address.toLowerCase();
}
