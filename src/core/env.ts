/** A copy of `env` without the cleared keys. The host applies the same list to a turn's env. */
export function withoutKeys(
  env: Record<string, string | undefined>,
  keys: readonly string[],
): Record<string, string | undefined> {
  const cleared = new Set(keys);
  return Object.fromEntries(Object.entries(env).filter(([key]) => !cleared.has(key)));
}
